package server

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/api"
	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/mcp"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/relay"
	remotetsnet "github.com/vuuihc/openkin/internal/remote/tsnet"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/routines"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/secret"
	"github.com/vuuihc/openkin/internal/skills"
	"github.com/vuuihc/openkin/internal/sleepguard"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
	"github.com/vuuihc/openkin/internal/terminal"
	"github.com/vuuihc/openkin/internal/usagewindows"
	"github.com/vuuihc/openkin/internal/workspace"
	"github.com/vuuihc/openkin/web"
)

const defaultPort = 7777

// ServeFlags are CLI options for `kin serve` (spec §7).
type ServeFlags struct {
	Port         int
	LAN          bool
	Tailscale    bool
	Funnel       bool
	TSControlURL string
	RelayURL     string   // WebSocket relay URL (e.g. wss://kin-relay.example.com)
	Args         []string // remaining args after command name
}

// ParseServeFlags parses flags from args (typically os.Args[2:]).
func ParseServeFlags(args []string) (ServeFlags, error) {
	var f ServeFlags
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.IntVar(&f.Port, "port", defaultPort, "HTTP listen port")
	fs.BoolVar(&f.LAN, "lan", false, "bind 0.0.0.0 and print LAN QR")
	fs.BoolVar(&f.Tailscale, "tailscale", false, "also serve via tsnet node \"kin\"")
	fs.BoolVar(&f.Funnel, "funnel", false, "public HTTPS via Tailscale Funnel (requires --tailscale)")
	fs.StringVar(&f.TSControlURL, "ts-control-url", "", "Headscale/custom control URL for tsnet")
	fs.StringVar(&f.RelayURL, "relay", "", "WebSocket relay URL (e.g. wss://kin-relay.example.com)")
	if err := fs.Parse(args); err != nil {
		return f, err
	}
	f.Args = fs.Args()

	if f.Funnel && !f.Tailscale {
		return f, fmt.Errorf("--funnel requires --tailscale")
	}
	if err := remotetsnet.ValidateFlags(f.Funnel, f.TSControlURL); err != nil {
		return f, err
	}
	if f.Port <= 0 {
		f.Port = defaultPort
	}
	return f, nil
}

// Serve starts the HTTP daemon on the configured transports (spec §7).
func Serve(version string) error {
	flags, err := ParseServeFlags(os.Args[2:])
	if err != nil {
		return err
	}
	return ServeWith(version, flags)
}

// ServeWith starts the daemon with explicit flags (tests / main).
func ServeWith(version string, flags ServeFlags) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("home dir: %w", err)
	}
	stateDir := filepath.Join(home, ".kin")
	if err := os.MkdirAll(filepath.Join(stateDir, "logs"), 0o700); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}

	token, err := remote.EnsureToken(stateDir)
	if err != nil {
		return err
	}
	tokenPath := remote.TokenFile(stateDir)

	// Port override for parallel local runs / tests (M1).
	port := flags.Port
	if p := os.Getenv("KIN_PORT"); p != "" {
		var n int
		if _, err := fmt.Sscanf(p, "%d", &n); err == nil && n > 0 {
			port = n
		}
	}

	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	secretStore, err := secret.NewDefaultStore(filepath.Join(stateDir, "secrets"))
	if err != nil {
		return err
	}
	provider.SetSecretStore(secretStore)
	taskBus := task.NewBus()
	connectorManager := connectors.NewManager(secretStore, connectors.StoreAuditSink{
		Store:     st,
		Publisher: taskBus,
	})

	// Persist control URL setting when provided.
	ctx := context.Background()
	if flags.TSControlURL != "" {
		_ = st.SetSetting(ctx, "tailscale.control_url", flags.TSControlURL)
	} else if v, err := st.GetSetting(ctx, "tailscale.control_url"); err == nil && v != "" && flags.Tailscale {
		flags.TSControlURL = v
		// Re-validate funnel + stored control URL.
		if err := remotetsnet.ValidateFlags(flags.Funnel, flags.TSControlURL); err != nil {
			return err
		}
	}

	// Build pluggable agent registry (composition root).
	daemonURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	tokenFn := func() string {
		b, err := os.ReadFile(filepath.Join(stateDir, "token"))
		if err != nil {
			return token
		}
		return strings.TrimSpace(string(b))
	}
	routingCatalog := routing.NewCatalog(st, nil)
	reg, err := buildAgentRegistry(ctx, st, daemonURL, tokenFn, routingCatalog, connectorManager)
	if err != nil {
		return err
	}
	routingCatalog = routing.NewCatalog(st, reg.Has)
	for _, info := range reg.List(ctx, "") {
		if info.Available {
			if info.Binary != "" {
				fmt.Printf("agent %s: %s\n", info.ID, info.Binary)
			} else {
				fmt.Printf("agent %s: ready\n", info.ID)
			}
		} else {
			reason := info.Reason
			if reason == "" {
				reason = "unavailable"
			}
			fmt.Printf("agent %s: %s\n", info.ID, reason)
		}
	}

	maxConcurrent := task.DefaultMaxConcurrent
	if v, err := st.GetSetting(ctx, "task.max_concurrent"); err == nil {
		if n, perr := strconv.Atoi(strings.TrimSpace(v)); perr == nil && n > 0 {
			maxConcurrent = n
		}
	}
	wsMgr := workspace.NewManager(stateDir)
	defaultPreference := func(c context.Context) (string, error) {
		pref, err := st.GetSetting(c, "agent.default")
		return strings.TrimSpace(pref), err
	}
	notifier := &notify.Sender{Store: st}
	workerRegistry := worker.NewRegistry(worker.DefaultLeaseTTL, func(record worker.Record) {
		notifier.NotifyWorkerOffline(context.Background(), record.WorkerID, "", record.Label)
	})
	// Session titles: truncate immediately, then replace via cognition provider when configured.
	titleResolver := func(c context.Context) (provider.Client, provider.Config, error) {
		cfg, err := provider.LoadConfig(c, st)
		if err != nil {
			return nil, cfg, err
		}
		if !cfg.Configured() {
			return nil, cfg, fmt.Errorf("provider not configured")
		}
		cli, err := provider.NewClient(cfg)
		return cli, cfg, err
	}
	// Share the same window prober with the engine for start-time preflight + auto-wait.
	usageWin := usagewindows.New(60*time.Second, &usagewindows.ClaudeProber{}, &usagewindows.CodexProber{})
	resolver := routing.NewDefaultResolver(routingCatalog, routing.WithUsageWindowChecker(usageWin))
	skillManager := skills.NewManager(skills.Config{
		BundledDir: filepath.Join(stateDir, "bundled-skills"),
		UserDir:    filepath.Join(stateDir, "skills"),
	})
	providerEntryResolver := func(ctx context.Context, providerID string) (adapter.ProviderConfig, error) {
		providerRegistry, err := provider.LoadRegistry(ctx, st)
		if err != nil {
			return adapter.ProviderConfig{}, err
		}
		entry, ok := providerRegistry.ByID(providerID)
		if !ok {
			return adapter.ProviderConfig{}, fmt.Errorf("provider %q not found", providerID)
		}
		cfg := entry.Config()
		return adapter.ProviderConfig{
			Kind:    cfg.Kind,
			BaseURL: cfg.BaseURL,
			APIKey:  cfg.APIKey,
			Model:   cfg.Model,
		}, nil
	}
	eng, err := task.NewConfiguredEngine(task.EngineConfig{
		Store:                 st,
		Agents:                reg,
		Bus:                   taskBus,
		MaxConcurrent:         maxConcurrent,
		Workspace:             wsMgr,
		DefaultPreference:     defaultPreference,
		Notifier:              notifier,
		TitleResolver:         titleResolver,
		UsageWindows:          usageWin,
		RoutingResolver:       resolver,
		ProviderEntryResolver: providerEntryResolver,
		Skills:                skillManager,
		ExpiryInterval:        time.Minute,
	})
	if err != nil {
		return err
	}
	defer eng.Close()
	if err := eng.Start(context.Background()); err != nil {
		return err
	}
	// Keep macOS awake while any durable task is active. This is deliberately
	// derived from the task bus so it also covers work started by Routines,
	// MCP, iOS, or a headless remote client.
	sleepGuard := sleepguard.New()
	guardCtx, guardCancel := context.WithCancel(context.Background())
	defer guardCancel()
	defer sleepGuard.Close()
	go runSleepGuard(guardCtx, sleepGuard, taskBus, func(ctx context.Context) (bool, error) {
		return st.HasActiveTasks(ctx)
	})
	// Routines start only after Engine recovery and dependency validation.
	routineScheduler := &routines.Scheduler{
		Store:            st,
		Engine:           eng,
		TotalConcurrency: maxConcurrent,
		ValidateCreate:   api.ValidateTaskCreateRequest,
		OnCreateFailed:   st.DeleteMCPTaskOrigin,
	}
	routineScheduler.StartLoop(context.Background(), routines.DefaultTickInterval)

	static, err := uiHandler()
	if err != nil {
		return err
	}

	auth := remote.NewFileAuth(tokenPath)
	mode := networkMode(flags)
	terminals := newTerminalManager(terminal.DetectProfiles)
	defer terminals.Close()

	srvAPI := &api.Server{
		Store:      st,
		Auth:       auth,
		Engine:     eng,
		Connectors: connectorManager,
		RunRoutine: func(c context.Context, id string) (store.Task, error) {
			return routineScheduler.RunNow(c, id)
		},
		MCP: &mcp.Server{
			Store:        st,
			Engine:       eng,
			ArtifactsDir: filepath.Join(stateDir, "artifacts"),
			Version:      version,
			ValidateCreate: func(c context.Context, req *task.CreateRequest) error {
				if req == nil {
					return fmt.Errorf("create request is required")
				}
				if req.Agent == "" {
					req.Agent = eng.DefaultAgentContext(c)
				}
				return api.ValidateTaskCreateRequest(c, *req)
			},
			ValidateFollowUp: func(c context.Context, id string, req *task.FollowUpRequest) error {
				return api.ValidateTaskFollowUpRequest(c, eng, id, req)
			},
			RunRoutine: func(c context.Context, id string, origin store.MCPTaskOrigin) (any, error) {
				return routineScheduler.RunNowWithOrigin(c, id, func(reserved store.Task) error {
					origin.TaskID = reserved.ID
					origin.CreatedAt = reserved.CreatedAt
					return st.RecordMCPTaskOrigin(c, origin)
				})
			},
			PrepareCreate: func(c context.Context, req *task.CreateRequest) {
				api.PrepareTaskCreate(c, st, filepath.Join(stateDir, "projects"), req)
			},
			RoutingStatus: func(c context.Context) (any, error) {
				defaults, err := routingCatalog.GetRoutingDefaults(c)
				if err != nil {
					return nil, err
				}
				teams, err := routingCatalog.ListTeamProfiles(c)
				if err != nil {
					return nil, err
				}
				providers, err := routingCatalog.ListProviderProfiles(c)
				if err != nil {
					return nil, err
				}
				return map[string]any{
					"defaults":  defaults,
					"teams":     teams,
					"providers": providers,
				}, nil
			},
		},
		Workspace:    wsMgr,
		Terminals:    terminals,
		Version:      version,
		Static:       static,
		UploadsDir:   filepath.Join(stateDir, "uploads"),
		ArtifactsDir: filepath.Join(stateDir, "artifacts"),
		ProjectsDir:  filepath.Join(stateDir, "projects"),
		Workers:      workerRegistry,
		ProviderResolve: func(c context.Context) (provider.Client, provider.Config, error) {
			cfg, err := provider.LoadConfig(c, st)
			if err != nil {
				return nil, cfg, err
			}
			if !cfg.Configured() {
				return nil, cfg, fmt.Errorf("provider not configured")
			}
			cli, err := provider.NewClient(cfg)
			return cli, cfg, err
		},
		NetworkMode: mode,
		// Probe provider subscription windows (5h/weekly) from the tokens the
		// Claude Code and Codex CLIs already store. Cached 60s to avoid
		// hammering providers (and spending Codex quota) on every page view.
		UsageWindows: usageWin,
		ListAgents: func() []api.AgentInfo {
			pref, _ := st.GetSetting(context.Background(), "agent.default")
			list := reg.List(context.Background(), strings.TrimSpace(pref))
			out := make([]api.AgentInfo, 0, len(list))
			seen := make(map[string]bool, len(list))
			for _, i := range list {
				caps := make([]string, 0, len(i.Capabilities))
				for _, c := range i.Capabilities {
					caps = append(caps, string(c))
				}
				models := make([]api.AgentModelOption, len(i.Models))
				for j, model := range i.Models {
					models[j] = api.AgentModelOption{
						ID:    model.ID,
						Label: model.Label,
						Tier:  model.Tier,
					}
				}
				out = append(out, api.AgentInfo{
					ID:              i.ID,
					Name:            i.Name,
					Kind:            string(i.Kind),
					Capabilities:    caps,
					Binary:          i.Binary,
					Installed:       i.Installed,
					Available:       i.Available,
					Reason:          i.Reason,
					Default:         i.Default,
					InstallURL:      detect.InstallURL(i.ID),
					Models:          models,
					ModelListSource: i.ModelSource,
					ModelListStatus: i.ModelStatus,
				})
				seen[i.ID] = true
			}
			// Merge full skills discovery catalog so the UI can show
			// presence-only / not-installed agents with install CTAs.
			for _, p := range detect.ScanPresence(strings.TrimSpace(pref)) {
				if seen[p.ID] {
					continue
				}
				reason := p.Reason
				if reason == "" {
					if p.Installed {
						reason = "installed; no known headless CLI mode"
					} else {
						reason = "not installed"
					}
				}
				out = append(out, api.AgentInfo{
					ID:              p.ID,
					Name:            p.Name,
					Kind:            "cli",
					Binary:          p.Binary,
					Installed:       p.Installed,
					Available:       false, // presence-only / Tier 3
					Reason:          reason,
					InstallURL:      detect.InstallURL(p.ID),
					ModelListSource: "none",
					ModelListStatus: "unavailable",
				})
				seen[p.ID] = true
			}
			return out
		},
		SmokeAgents: func(c context.Context, ids []string) []api.AgentSmokeResult {
			return api.RunGenericCLISmoke(c, st, ids)
		},
	}

	handler := srvAPI.Handler()

	// Build transports.
	cfg := remote.Config{Port: port}
	var transports []remote.Transport
	if flags.LAN {
		transports = append(transports, remote.LAN{})
	} else {
		transports = append(transports, remote.Loopback{})
	}

	var tsTransport *remotetsnet.Transport
	if flags.Tailscale {
		tsDir := filepath.Join(stateDir, "tsnet")
		tsTransport = &remotetsnet.Transport{
			OnReady: func(base string) {
				fmt.Printf("tsnet ready: %s\n", base)
			},
		}
		_ = tsDir // used in cfg below
		transports = append(transports, tsTransport)
	}

	listenCtx, listenCancel := context.WithCancel(context.Background())
	defer listenCancel()
	go runWorkerLeaseSweep(listenCtx, workerRegistry)

	var listeners []listenerInfo

	for _, tr := range transports {
		tcfg := cfg
		if tr.Name() == "tsnet" {
			tcfg.Hostname = "kin"
			tcfg.StateDir = filepath.Join(stateDir, "tsnet")
			tcfg.ControlURL = flags.TSControlURL
			tcfg.Funnel = flags.Funnel
		}
		ln, err := tr.Listen(listenCtx, tcfg)
		if err != nil {
			// Close any already-open listeners.
			for _, a := range listeners {
				if a.ln != nil {
					_ = a.ln.Close()
				}
			}
			return fmt.Errorf("%s: %w", tr.Name(), err)
		}
		a := listenerInfo{name: tr.Name(), ln: ln}
		switch tr.Name() {
		case "loopback":
			a.url = fmt.Sprintf("http://127.0.0.1:%d", port)
			a.open = a.url + "/?token=" + auth.Token()
			a.qr = a.url + "/?token=" + auth.Token()
		case "lan":
			ip := remote.PrimaryLANIP()
			a.url = fmt.Sprintf("http://%s:%d", ip, port)
			a.open = a.url + "/?token=" + auth.Token()
			a.qr = a.url + "/?token=" + auth.Token()
		case "tsnet":
			if tsTransport != nil && tsTransport.Server() != nil {
				s := tsTransport.Server()
				if flags.Funnel {
					if u := s.FunnelURL(); u != "" {
						a.url = u
					} else if u := s.TailnetURL(); u != "" {
						// Funnel URL may appear after certs; fall back to tailnet HTTPS guess.
						a.url = strings.Replace(u, "http://", "https://", 1)
					}
				} else if u := s.TailnetURL(); u != "" {
					a.url = u
					// Append port if not default and URL is hostname-based without port.
					if port != 80 && port != 443 && !strings.Contains(u, ":"+fmt.Sprint(port)) {
						a.url = fmt.Sprintf("%s:%d", u, port)
					}
				}
			}
			if a.url == "" {
				a.url = fmt.Sprintf("http://kin:%d", port)
			}
			a.open = a.url + "/?token=" + auth.Token()

			a.qr = a.url + "/?token=" + auth.Token()
		}
		a.qr, err = issuePairingURL(ctx, st, a.qr, tr.Name())
		if err != nil {
			return err
		}
		listeners = append(listeners, a)
	}

	// Start relay bridge if configured.
	var relayBridge *relay.Bridge
	if flags.RelayURL != "" {
		var relayErr error
		relayBridge, relayErr = relay.NewPersistentBridge(flags.RelayURL, stateDir, daemonURL)
		if relayErr != nil {
			return fmt.Errorf("initialize relay: %w", relayErr)
		}

		// Add synthetic listener entry for QR / URL display.
		relayConnectURL, relayErr := issuePairingURL(
			ctx, st, relayBridge.ConnectURLWithKey()+"&token="+auth.Token(), "relay",
		)
		if relayErr != nil {
			return relayErr
		}
		listeners = append(listeners, listenerInfo{
			name: "relay",
			url:  relayBridge.ConnectURL(),
			open: relayBridge.ConnectURLWithKey() + "&token=" + auth.Token(),
			qr:   relayConnectURL,
		})

		go func() {
			if err := relayBridge.Run(listenCtx); err != nil && listenCtx.Err() == nil {
				fmt.Fprintf(os.Stderr, "relay bridge error: %v\n", err)
			}
		}()
	}

	// ui.base_url = most-public active listener (funnel > tsnet > relay > lan > loopback).
	baseURL := mostPublicURL(listeners)
	if baseURL != "" {
		_ = st.SetSetting(ctx, notify.KeyBaseURL, baseURL)
		srvAPI.BaseURL = baseURL
	}
	// Connection URL for Settings QR (with token).
	if qr := mostPublicQR(listeners); qr != "" {
		srvAPI.ConnectURL = qr
	}
	srvAPI.Token = auth.Token()
	// Token re-read for settings API.
	srvAPI.TokenFn = auth.Token

	// Print status + QR.
	fmt.Printf("kin listening (%s)\n", mode)
	for _, a := range listeners {
		fmt.Printf("  [%s] %s\n", a.name, a.ln.Addr())
		if a.url != "" {
			fmt.Printf("       %s\n", a.url)
		}
		if a.open != "" {
			fmt.Printf("       web: %s\n", a.open)
		}
	}
	fmt.Printf("  token file: %s\n", tokenPath)

	// Print the browser link and the one-time pairing link separately.
	if openURL := mostPublicOpen(listeners); openURL != "" {
		fmt.Printf("  open: %s\n", openURL)
	}
	qrURL := mostPublicQR(listeners)
	if qrURL != "" {
		fmt.Printf("  pair: %s\n", qrURL)
		if flags.LAN || flags.Tailscale {
			fmt.Println()
			if err := remote.PrintQR(os.Stdout, qrURL); err != nil {
				fmt.Fprintf(os.Stderr, "warning: qr: %v\n", err)
			}
		}
	}

	// Serve all listeners.
	httpServer := &http.Server{Handler: handler}
	errCh := make(chan error, len(listeners))
	var wg sync.WaitGroup
	for _, a := range listeners {
		if a.ln == nil {
			continue
		}
		wg.Add(1)
		go func(ln net.Listener) {
			defer wg.Done()
			err := httpServer.Serve(ln)
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- err
			}
		}(a.ln)
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		fmt.Printf("\nkin: got %v, shutting down\n", sig)
	case err := <-errCh:
		listenCancel()
		_ = httpServer.Close()
		for _, a := range listeners {
			if a.ln != nil {
				_ = a.ln.Close()
			}
		}
		return err
	}

	listenCancel()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	for _, a := range listeners {
		if a.ln != nil {
			_ = a.ln.Close()
		}
	}
	wg.Wait()
	return nil
}

func runSleepGuard(
	ctx context.Context,
	guard *sleepguard.Guard,
	bus *task.Bus,
	hasActive func(context.Context) (bool, error),
) {
	for {
		if bus == nil {
			_ = guard.Close()
			return
		}
		sub := bus.Subscribe()
		active := false
		if hasActive != nil {
			if current, err := hasActive(ctx); err == nil {
				active = current
			}
		}
		if err := guard.SetActive(ctx, active); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "kin: sleep guard: %v\n", err)
		}
		for {
			select {
			case <-ctx.Done():
				bus.Unsubscribe(sub)
				_ = guard.SetActive(context.Background(), false)
				return
			case msg, ok := <-sub:
				if !ok {
					// The bus closes a lagging subscriber. Release the
					// inhibitor before resubscribing so state is rebuilt.
					_ = guard.SetActive(context.Background(), false)
					goto resubscribe
				}
				switch msg.Kind {
				case "task_update", "task_deleted":
					if hasActive != nil {
						current, err := hasActive(ctx)
						if err != nil {
							continue
						}
						active = current
					} else if t, ok := msg.Data.(store.Task); ok {
						active = isActiveTaskStatus(t.Status)
					}
				default:
					continue
				}
				if err := guard.SetActive(ctx, active); err != nil && ctx.Err() == nil {
					fmt.Fprintf(os.Stderr, "kin: sleep guard: %v\n", err)
				}
			}
		}
	resubscribe:
		if ctx.Err() != nil {
			return
		}
	}
}

func runWorkerLeaseSweep(ctx context.Context, registry *worker.Registry) {
	if registry == nil {
		return
	}
	ticker := time.NewTicker(worker.DefaultLeaseTTL / 2)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			registry.Sweep()
		}
	}
}

func isActiveTaskStatus(status string) bool {
	switch status {
	case task.StatusQueued, task.StatusRunning, task.StatusWaitingApproval,
		task.StatusWaitingInput, task.StatusRetrying:
		return true
	default:
		return false
	}
}

func newTerminalManager(detectProfiles func() []terminal.Profile) *terminal.Manager {
	return terminal.NewManager(detectProfiles())
}

func networkMode(f ServeFlags) string {
	var parts []string
	if f.LAN {
		parts = append(parts, "lan")
	} else {
		parts = append(parts, "loopback")
	}
	if f.RelayURL != "" {
		parts = append(parts, "relay")
	}
	if f.Tailscale {
		if f.Funnel {
			parts = append(parts, "tailscale+funnel")
		} else {
			parts = append(parts, "tailscale")
		}
	}
	return strings.Join(parts, "+")
}

// listenerInfo is a named bound listener with display URLs.
type listenerInfo struct {
	name string
	ln   net.Listener
	url  string // base URL without token (for ui.base_url)
	open string // browser URL with the master token
	qr   string // full URL with token for QR
}

// rank: funnel/tsnet https > tsnet > relay > lan > loopback
func publicityRank(name, url string) int {
	if strings.HasPrefix(url, "https://") {
		return 5
	}
	switch name {
	case "tsnet":
		return 4
	case "relay":
		return 3
	case "lan":
		return 2
	case "loopback":
		return 1
	}
	return 0
}

func mostPublicURL(listeners []listenerInfo) string {
	best := ""
	bestR := -1
	for _, a := range listeners {
		if a.url == "" {
			continue
		}
		r := publicityRank(a.name, a.url)
		if r > bestR {
			bestR = r
			best = a.url
		}
	}
	return best
}

func mostPublicQR(listeners []listenerInfo) string {
	best := ""
	bestR := -1
	for _, a := range listeners {
		if a.qr == "" {
			continue
		}
		r := publicityRank(a.name, a.url)
		if r > bestR {
			bestR = r
			best = a.qr
		}
	}
	return best
}

func mostPublicOpen(listeners []listenerInfo) string {
	best := ""
	bestR := -1
	for _, a := range listeners {
		if a.open == "" {
			continue
		}
		r := publicityRank(a.name, a.url)
		if r > bestR {
			bestR = r
			best = a.open
		}
	}
	return best
}

func uiHandler() (http.Handler, error) {
	sub, err := fs.Sub(web.FS, "dist")
	if err != nil {
		return nil, fmt.Errorf("embed web: %w", err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// SPA fallback: serve index.html for non-file client routes.
		path := r.URL.Path
		serveIndex := path == "/" || path == "/index.html"
		if path != "/" && !strings.Contains(path, ".") {
			if f, err := sub.Open(strings.TrimPrefix(path, "/")); err == nil {
				_ = f.Close()
			} else {
				r = r.Clone(r.Context())
				r.URL.Path = "/"
				serveIndex = true
			}
		}
		// Hashed Vite assets are content-addressed → long-lived immutable cache.
		// index.html (and SPA shell routes) must revalidate so clients pick up new hashes.
		if strings.HasPrefix(path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else if serveIndex || path == "/manifest.webmanifest" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if path == "/manifest.webmanifest" {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		fileServer.ServeHTTP(w, r)
	}), nil
}
