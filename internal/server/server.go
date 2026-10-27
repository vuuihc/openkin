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
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/openkin/internal/a2a"
	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/api"
	authsvc "github.com/vuuihc/openkin/internal/auth"
	"github.com/vuuihc/openkin/internal/browserworker"
	"github.com/vuuihc/openkin/internal/cloudflare"
	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/eval"
	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/hub/workers"
	"github.com/vuuihc/openkin/internal/mcp"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/remote"
	remotetsnet "github.com/vuuihc/openkin/internal/remote/tsnet"
	"github.com/vuuihc/openkin/internal/routines"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/secret"
	"github.com/vuuihc/openkin/internal/skills"
	"github.com/vuuihc/openkin/internal/sleepguard"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
	"github.com/vuuihc/openkin/internal/terminal"
	"github.com/vuuihc/openkin/internal/workspace"
	"github.com/vuuihc/openkin/web"
)

const defaultPort = 7777

// stringList collects a flag given more than once, and also splits commas, so
// `--root a --root b` and `--root a,b` mean the same thing.
type stringList []string

func (l *stringList) String() string { return strings.Join(*l, ",") }

func (l *stringList) Set(value string) error {
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			*l = append(*l, item)
		}
	}
	return nil
}

// Roles a Kin process can take. A machine that works for someone else's Hub is
// still a standalone daemon locally; --hub is what makes it a Node.
const (
	RoleStandalone = "standalone"
	RoleHub        = "hub"
)

// ServeFlags are CLI options for `kin serve` (spec §7).
type ServeFlags struct {
	Port         int
	LAN          bool
	Tailscale    bool
	Funnel       bool
	TSControlURL string
	RelayURL     string // WebSocket relay URL (e.g. wss://kin-relay.example.com)
	Role         string // standalone (default) or hub
	Domain       string // public hostname; required for --role hub
	ACMEEmail    string // Let's Encrypt contact address; optional
	// HubURL makes this daemon a Node: it keeps serving this machine and also
	// runs turns the named Hub dispatches here.
	HubURL string
	// NodeToken is the device credential `kin hub node-token` printed. It is
	// only used when HubURL is set, and falls back to ~/.kin/node-token.
	NodeToken string
	// NodeRoots are extra directories this machine will run dispatched work in,
	// on top of the projects it already has.
	NodeRoots []string
	// CheckoutRoot is where this machine keeps the repositories it fetches for a
	// console that cannot reach them itself. Empty means the default under the
	// state directory, and "off" means it fetches none.
	CheckoutRoot string
	// AllowYOLO lets a dispatched turn run with the agent's permission system
	// switched off. Off unless the operator of this machine says otherwise.
	AllowYOLO bool
	Args      []string // remaining args after command name
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
	fs.StringVar(&f.Role, "role", RoleStandalone, "process role: standalone or hub")
	fs.StringVar(&f.Domain, "domain", "", "public hostname for --role hub (e.g. kin.example.com)")
	fs.StringVar(&f.ACMEEmail, "acme-email", "", "Let's Encrypt contact address for --role hub")
	fs.StringVar(&f.HubURL, "hub", "", "run turns for this Hub (makes this machine a Node)")
	fs.StringVar(&f.NodeToken, "token", "", "device token for --hub; defaults to ~/.kin/node-token")
	var roots stringList
	fs.Var(&roots, "root", "an extra directory to run dispatched work in (repeatable, comma-separated)")
	fs.StringVar(&f.CheckoutRoot, "checkout-root", "",
		"where to keep repositories fetched for a remote console (default <state dir>/checkouts, \"off\" to fetch none)")
	fs.BoolVar(&f.AllowYOLO, "allow-yolo", false, "let turns dispatched from --hub run with agent permissions bypassed")
	if err := fs.Parse(args); err != nil {
		return f, err
	}
	f.Args = fs.Args()
	f.NodeRoots = roots

	f.Role = strings.ToLower(strings.TrimSpace(f.Role))
	if f.Role == "" {
		f.Role = RoleStandalone
	}
	switch f.Role {
	case RoleStandalone, RoleHub:
	default:
		return f, fmt.Errorf("unknown --role %q (want %s or %s; a machine that works for a Hub keeps --role standalone and adds --hub)",
			f.Role, RoleStandalone, RoleHub)
	}
	if f.Role == RoleHub && strings.TrimSpace(f.Domain) == "" {
		return f, fmt.Errorf("--role hub requires --domain")
	}
	if f.Role == RoleStandalone && strings.TrimSpace(f.Domain) != "" {
		return f, fmt.Errorf("--domain requires --role hub")
	}
	if f.Funnel && !f.Tailscale {
		return f, fmt.Errorf("--funnel requires --tailscale")
	}
	if err := remotetsnet.ValidateFlags(f.Funnel, f.TSControlURL); err != nil {
		return f, err
	}
	// A Hub is the machine everything else reports to; it does not itself report
	// to another one, and two Hubs pointing at each other is a configuration
	// nobody means to write.
	if f.Role == RoleHub && strings.TrimSpace(f.HubURL) != "" {
		return f, fmt.Errorf("--hub cannot be combined with --role hub: a Hub does not work for another Hub")
	}
	if f.Port <= 0 {
		f.Port = defaultPort
	}
	return f, nil
}

// warnToStderr is where the remote path reports what it cannot hand back to a
// caller: a cancel that never reached a device, a question whose asker went
// away, a turn nobody started in time.
func warnToStderr(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "kin: warning: "+format+"\n", args...)
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
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
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
	// Pull-request state is read with the machine's own credentials — the user's
	// GitHub CLI, or an unauthenticated read of the public API. No token is
	// stored, so there is nothing here to pass a secret store to.
	githubService := github.NewService(st)

	// Persist control URL setting when provided.
	ctx := context.Background()
	identity, err := ensureDesktopIdentity(ctx, st)
	if err != nil {
		return err
	}
	// The Hub is a machine too. It needs a device row for the same reason a
	// paired one does: a workspace anchor's per-device path keys on devices.id,
	// and a task the Hub runs itself has a workspace like any other.
	if err := st.RegisterLocalDevice(ctx, store.Device{
		ID:         identity.ID,
		Label:      identity.Name,
		Platform:   runtime.GOOS,
		Arch:       runtime.GOARCH,
		Role:       "hub",
		KinVersion: version,
	}, time.Now().UnixMilli()); err != nil {
		return err
	}
	// Session rows written before a session's identity named a machine are this
	// machine's: this daemon owns this database, and it is the only thing that
	// ever wrote them.
	if err := st.AdoptUnownedAgentSessions(ctx, identity.ID); err != nil {
		return err
	}
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
	relayCtx, relayCancel := context.WithCancel(context.Background())
	defer relayCancel()
	relayRuntime := newRelayRuntime(
		relayCtx,
		stateDir,
		daemonURL,
		st,
		tokenFn,
		identity,
	)
	defer relayRuntime.Stop()
	fallbackBaseURL := daemonURL
	routingCatalog := routing.NewCatalog(st, nil)
	reg, err := buildAgentRegistry(ctx, st, daemonURL, tokenFn, routingCatalog, connectorManager, version)
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
	workerRegistry := workers.NewRegistry(workers.DefaultLeaseTTL, func(record workers.Record) {
		notifier.NotifyWorkerOffline(context.Background(), record.WorkerID, "", record.Label)
	})
	// Nodes are the machines that run turns with their own agents. The
	// connection table is process-local by nature — only the process holding the
	// socket knows a device is connected — while the device row it writes to is
	// durable, so a Hub restart costs presence, not knowledge.
	//
	// It is built here, empty, and filled in below once the engine exists: a
	// connection ending has to settle both what it was running and what it was
	// asking, and both of those live in the engine.
	var nodeTurns *node.Turns
	var nodeApprovals *node.Approvals
	// Questions this Hub has asked its machines wait here for their answers. The
	// table is a field rather than a value from the start for the same reason as
	// the two above: a connection ending has to reach it from inside this hook.
	var nodeQueries *node.Queries
	// A connection ending — dropped, or replaced by a newer one — ends whatever
	// it was running, and says so in each transcript: the alternative is a turn
	// that waits forever on a socket that no longer exists. It is scoped to that
	// connection: a machine that reconnects while a turn is being dispatched must
	// not have the new turn killed by the old socket's ending.
	//
	// A question in flight is settled first, and for a different reason: an
	// answer cannot arrive on a connection that has ended, and whoever asked is
	// waiting on it — an HTTP request, a phone, a person watching a spinner.
	// Saying so now is the difference between a sentence and a timeout.
	//
	// The approvals go before the turns, and the order matters: settling one can
	// push its task out of waiting_approval and back into running, and failing
	// the turn afterwards overwrites that with failed. The other order leaves a
	// task that says running with no run loop behind it.
	nodeConns := node.NewConnections(func(ended node.Sender) {
		if nodeQueries != nil {
			for _, queryID := range nodeQueries.Abandon(ended) {
				fmt.Fprintf(os.Stderr, "kin: warning: question %s ended with its device connection\n", queryID)
			}
		}
		if nodeApprovals != nil {
			for _, approvalID := range nodeApprovals.Abandon(ended) {
				fmt.Fprintf(os.Stderr, "kin: warning: approval %s settled when its device disconnected\n", approvalID)
			}
		}
		if nodeTurns != nil {
			for _, turnID := range nodeTurns.Abandon(ended) {
				fmt.Fprintf(os.Stderr, "kin: warning: turn %s lost its connection\n", turnID)
			}
		}
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
	resolver := routing.NewDefaultResolver(routingCatalog)
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
	browser, err := configureBrowserWorker(stateDir, st, eng, taskBus)
	if err != nil {
		return err
	}
	if browser != nil {
		defer browser.Close()
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
	static, err := uiHandler()
	if err != nil {
		return err
	}

	auth := remote.NewFileAuth(tokenPath)
	mode := networkMode(flags)

	// A Hub owns accounts and terminates its own TLS. A standalone daemon does
	// neither: it keeps the token-only behavior it has always had, so nothing
	// about local use changes.
	var hub *remote.Hub
	var accounts *authsvc.Service
	var oidcProvider *authsvc.OIDCProvider
	if flags.Role == RoleHub {
		hub, err = remote.NewHub(remote.HubConfig{
			Domain:   flags.Domain,
			Email:    flags.ACMEEmail,
			StateDir: stateDir,
		})
		if err != nil {
			return err
		}
		defer func() { _ = hub.Close() }()

		accounts = authsvc.New(st, authsvc.Config{})
		oidcProvider, err = buildOIDCProvider(context.Background(), hub)
		if err != nil {
			return err
		}
	}
	terminals := newTerminalManager(terminal.DetectProfiles)
	defer terminals.Close()
	suitesDir := os.Getenv("KIN_EVAL_SUITES_DIR")
	if strings.TrimSpace(suitesDir) == "" {
		suitesDir = filepath.Join(stateDir, "eval", "suites")
	}
	// Remote execution is an adapter, so a turn that runs on another machine
	// takes the same path through the engine as one that runs here: same event
	// storage, same cursor, same console (ADR 0022 D8).
	nodeTurns = node.NewTurns()
	nodeTurns.Warn = warnToStderr
	// A permission question asked on a machine this Hub dispatched to is the
	// Hub's to put in front of a person: the device is blocked, the console is
	// where somebody is looking, and one inbox for both is the whole point of
	// having a Hub (ADR 0022 D1).
	nodeApprovals = &node.Approvals{
		Turns:  nodeTurns,
		Engine: eng,
		Warn:   warnToStderr,
	}
	eng.SetRemoteRunner(identity.ID, func(t store.Task, executionID string) (adapter.Adapter, error) {
		return &node.Adapter{
			Conns: nodeConns, Turns: nodeTurns,
			DeviceID:    t.ExecutingDeviceID,
			DeviceLabel: deviceLabel(st, t.ExecutingDeviceID),
		}, nil
	})

	evalRunner := &eval.Runner{
		Store:        st,
		Engine:       eng,
		SuitesDir:    suitesDir,
		ArtifactsDir: filepath.Join(stateDir, "artifacts"),
	}
	if err := evalRunner.Resume(context.Background()); err != nil {
		return fmt.Errorf("resume eval runs: %w", err)
	}
	// Routines start only after Engine recovery, eval recovery, and dependency
	// validation so eval lanes cannot fall back to ordinary task creation.
	routineScheduler := &routines.Scheduler{
		Store:            st,
		Engine:           eng,
		TotalConcurrency: maxConcurrent,
		ValidateCreate: func(c context.Context, req task.CreateRequest) error {
			if err := api.ValidateTaskCreateRequest(c, req); err != nil {
				return err
			}
			return api.ValidateExecutingDevice(c, st, identity.ID, req.ExecutingDeviceID)
		},
		OnCreateFailed: st.DeleteMCPTaskOrigin,
		RunEval:        evalRunner.StartRoutine,
	}
	routineScheduler.StartLoop(context.Background(), routines.DefaultTickInterval)

	// The directories this machine works in: its own projects, plus anything the
	// operator adds by hand. One list, read by everything that decides where the
	// boundary is — the executor that runs dispatched work in one of them, the
	// answers this machine gives about its own filesystem, and the hello that
	// tells a Hub which of them it may ask for.
	//
	// The checkout root joins that list, and that is deliberate: a checkout is
	// only useful as a working directory, so a machine that fetches repositories
	// for a phone is a machine that runs work in them. It is one list rather than
	// a second one because a directory the console can pick is a directory the
	// executor must accept, and two lists are how those drift apart.
	checkoutRoot, machineRoots, err := workRoots(ctx, st, stateDir, flags)
	if err != nil {
		return err
	}
	nodeQueries = node.NewQueries()

	srvAPI := &api.Server{
		Store:      st,
		Auth:       auth,
		Accounts:   accounts,
		OIDC:       oidcProvider,
		Engine:     eng,
		Agents:     reg,
		Connectors: connectorManager,
		GitHub:     githubService,
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
				if err := api.ValidateTaskCreateRequest(c, *req); err != nil {
					return err
				}
				// The same device check the REST surface makes: an agent asking
				// for a machine that does not exist, or one that has been
				// revoked, should be told now rather than when a turn fails.
				return api.ValidateExecutingDevice(c, st, identity.ID, req.ExecutingDeviceID)
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
		DesktopID:    identity.ID,
		DesktopName:  identity.Name,
		Static:       static,
		UploadsDir:   filepath.Join(stateDir, "uploads"),
		ArtifactsDir: filepath.Join(stateDir, "artifacts"),
		ProjectsDir:  filepath.Join(stateDir, "projects"),
		Workers:      workerRegistry,
		Nodes:        nodeConns,
		Queries:      nodeQueries,
		// This daemon is a machine too, and its own console picks directories on
		// it. The answer comes from the same code that answers a Hub, with the
		// same list of directories the executor works in, so a directory this
		// console offers is a directory this machine will actually run in.
		//
		// The session catalog is handed over for the same reason and in the same
		// spirit: the sessions that live here are read by the console's own
		// import and by a Hub asking this machine, and both go through the
		// registry so that a provider this machine cannot read is reported the
		// same way wherever the question came from.
		LocalMachine: &node.Responder{
			Roots: machineRoots, CheckoutRoot: checkoutRoot, Workspace: wsMgr,
			Sessions: reg, Warn: warnToStderr,
		},
		NodeFrames: node.RouteFrame(nodeTurns, nodeApprovals, nodeQueries),
		Browser:    browser,
		Eval:       evalRunner,
		A2A:        &a2a.Server{Store: st, Engine: eng, Version: version, Enabled: strings.EqualFold(os.Getenv("KIN_A2A_ENABLED"), "1")},
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
		RelaySnapshot:       relayRuntime.Snapshot,
		RefreshRelayPairing: relayRuntime.RefreshPairing,
		NetworkMode:         mode,
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
				if _, hasCatalog := reg.SessionCatalog(i.ID); !hasCatalog {
					filtered := caps[:0]
					for _, capability := range caps {
						if strings.HasPrefix(capability, "session_") {
							continue
						}
						filtered = append(filtered, capability)
					}
					caps = filtered
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
		ListAgentProviders: func() []agent.ProviderInfo {
			return listAgentProviders(reg)
		},
		SmokeAgents: func(c context.Context, ids []string) []api.AgentSmokeResult {
			return api.RunGenericCLISmoke(c, st, ids)
		},
		Cloudflare: &cloudflare.Service{
			Store:       st,
			Secrets:     secretStore,
			RedirectURI: daemonURL + "/api/cloudflare/oauth/callback",
		},
	}
	// Pull-request state for a session that runs on another machine is read by
	// that machine — its credentials, its checkout — so the service needs the
	// Hub's own view of the paired machines to ask one. Bound here because this
	// is where both exist.
	srvAPI.BindGitHubMachines()
	srvAPI.ConfigureRelay = func(c context.Context, rawURL string) (api.RelayStatus, error) {
		status, err := relayRuntime.Configure(c, rawURL)
		if err != nil {
			return status, err
		}
		baseURL := daemonURL
		if status.URL != "" {
			baseURL = relayRuntime.BaseURL()
		} else {
			baseURL = fallbackBaseURL
		}
		if err := st.SetSetting(c, notify.KeyBaseURL, baseURL); err != nil {
			return status, fmt.Errorf("persist relay base URL: %w", err)
		}
		srvAPI.BaseURL = baseURL
		return status, nil
	}

	if _, err := buildFederationProxy(hub, srvAPI); err != nil {
		return err
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
	if hub != nil {
		transports = append(transports, hub)
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
	go runPRReconcile(listenCtx, githubService)

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
		case "hub":
			// The Hub's public URL carries no token: visitors sign in. The
			// master token still works over HTTPS for CLI and MCP clients, but
			// it is never printed into a URL that could end up in a browser
			// history or a shared screenshot.
			a.tls = true
			a.url = hub.URL()
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
		a.qr, err = issuePairingURL(ctx, st, a.qr, tr.Name(), identity)
		if err != nil {
			return err
		}
		listeners = append(listeners, a)
	}

	// Start Relay from the CLI override or the persisted Settings value.
	// Settings can later reconfigure the same runtime without restarting the
	// daemon.
	initialRelayURL := strings.TrimSpace(flags.RelayURL)
	if initialRelayURL == "" {
		initialRelayURL, _ = st.GetSetting(ctx, "relay.url")
	}
	if directURL := mostPublicURL(listeners); directURL != "" {
		fallbackBaseURL = directURL
	}
	if initialRelayURL != "" {
		relayStatus, relayErr := srvAPI.ConfigureRelay(ctx, initialRelayURL)
		if relayErr != nil {
			return relayErr
		}
		listeners = append(listeners, listenerInfo{
			name: "relay",
			url:  relayRuntime.BaseURL(),
			open: relayStatus.OpenURL,
			qr:   relayStatus.PairingURL,
		})
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
		if a.ln != nil {
			fmt.Printf("  [%s] %s\n", a.name, a.ln.Addr())
		} else {
			fmt.Printf("  [%s]\n", a.name)
		}
		if a.url != "" {
			fmt.Printf("       %s\n", a.url)
		}
		if a.open != "" {
			fmt.Printf("       web: %s\n", a.open)
		}
	}
	fmt.Printf("  token file: %s\n", tokenPath)
	if checkoutRoot != "" {
		// The one root nobody chose. It joins this machine's roots, so it is a
		// directory work may be sent to and a directory a console offers; an
		// operator who wants that boundary narrower has to be able to see it was
		// widened, and how to narrow it.
		fmt.Printf("  checkout root: %s (--checkout-root off fetches nothing)\n", checkoutRoot)
	}

	if accounts != nil {
		printBootstrapState(context.Background(), accounts)
	}

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

	// A daemon that works for a Hub keeps working for it for as long as it runs.
	// Losing the Hub is not fatal: this machine's own console keeps serving
	// while the connection is retried.
	nodeCtx, stopNode := context.WithCancel(context.Background())
	defer stopNode()
	if strings.TrimSpace(flags.HubURL) != "" {
		executor := &node.Executor{
			Runners:   agentRunners{reg: reg},
			AllowYOLO: flags.AllowYOLO,
			Warn:      warnToStderr,
			// The same list the console reads and the Hub is told about: what this
			// machine offers to work in is what it will accept work in.
			Roots: machineRoots,
		}
		defer executor.Stop()
		// A permission question about a turn this machine took from its Hub goes
		// back over the same channel the turn arrived on. The agent still asks
		// this daemon — it is the daemon the agent can reach — and the answer
		// comes from wherever the person is looking (ADR 0022 D1).
		approvalRelay := &node.ApprovalRelay{
			Executor: executor,
			Warn:     warnToStderr,
		}
		srvAPI.ApprovalRelay = approvalRelay
		go func() {
			err := runNode(nodeCtx, version, flags, st, reg, executor, approvalRelay, srvAPI.LocalMachine)
			// A canceled context is this daemon shutting down, not a failure.
			if err != nil && nodeCtx.Err() == nil {
				fmt.Fprintf(os.Stderr, "kin: node: %v\n", err)
			}
		}()
	}

	// Serve all listeners. TLSConfig must be set before any Serve call, so it
	// is assigned here rather than inside the loop.
	httpServer := &http.Server{Handler: handler}
	if hub != nil {
		httpServer.TLSConfig = hub.TLSConfig()
		if err := hub.StartChallengeServer(); err != nil {
			// Losing the challenge port does not stop an already-cached
			// certificate from working, so this is a warning rather than a
			// failure to start. Renewal will fail later, loudly.
			fmt.Fprintf(os.Stderr, "kin: warning: %v\n", err)
			fmt.Fprintln(os.Stderr, "kin: warning: certificate renewal will fail until port 80 is reachable")
		}
	}
	errCh := make(chan error, len(listeners))
	var wg sync.WaitGroup
	for _, a := range listeners {
		if a.ln == nil {
			continue
		}
		wg.Add(1)
		go func(a listenerInfo) {
			defer wg.Done()
			var err error
			if a.tls {
				// ServeTLS with empty file paths uses TLSConfig.GetCertificate,
				// which is autocert's hook. It also configures HTTP/2, which
				// wrapping the listener by hand would not.
				err = httpServer.ServeTLS(a.ln, "", "")
			} else {
				err = httpServer.Serve(a.ln)
			}
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- err
			}
		}(a)
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

// prReconcileInterval and prReconcileBatch bound the background pull-request
// pass. The batch is deliberately small: a person has a handful of open pull
// requests, and the pass exists to notice checks finishing, not to keep the
// whole history current.
const (
	prReconcileInterval = 60 * time.Second
	prReconcileBatch    = 25
)

// runPRReconcile keeps open pull requests fresh.
//
// Only open pull requests are walked, and each is skipped until its own
// credential-appropriate floor has passed, so this stays well inside both the
// authenticated and the anonymous rate limits.
func runPRReconcile(ctx context.Context, svc *github.Service) {
	if svc == nil {
		return
	}
	ticker := time.NewTicker(prReconcileInterval)
	defer ticker.Stop()
	// An open pull request whose read keeps failing would otherwise print the
	// same line every minute for as long as it stays open. Report the change of
	// state, not the passage of time.
	var lastLogged string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := svc.Reconcile(ctx, prReconcileBatch)
			if ctx.Err() != nil {
				return
			}
			msg := ""
			if err != nil {
				msg = err.Error()
			}
			if msg != lastLogged {
				lastLogged = msg
				if msg != "" {
					fmt.Fprintf(os.Stderr, "kin: github reconcile: %s\n", msg)
				} else {
					fmt.Fprintln(os.Stderr, "kin: github reconcile: recovered")
				}
			}
		}
	}
}

func runWorkerLeaseSweep(ctx context.Context, registry *workers.Registry) {
	if registry == nil {
		return
	}
	ticker := time.NewTicker(workers.DefaultLeaseTTL / 2)
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

// deviceLabel is what to call a device in a line a person reads. A device that
// was never given a name, or is no longer in the registry, is called by its id:
// the message is about the machine either way, and an unnamed machine has
// nothing better to offer.
func deviceLabel(st *store.Store, deviceID string) string {
	device, err := st.GetDevice(context.Background(), deviceID)
	if err != nil || strings.TrimSpace(device.Label) == "" {
		return deviceID
	}
	return strings.TrimSpace(device.Label)
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
	// tls marks a listener that must be served with the Hub's certificate.
	tls bool
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

func configureBrowserWorker(
	stateDir string,
	st *store.Store,
	eng *task.Engine,
	bus *task.Bus,
) (*browserworker.Runner, error) {
	script := strings.TrimSpace(os.Getenv("KIN_BROWSER_WORKER_SCRIPT"))
	if script == "" {
		return nil, nil
	}
	script, err := filepath.Abs(script)
	if err != nil {
		return nil, fmt.Errorf("browser worker script path: %w", err)
	}
	if info, statErr := os.Stat(script); statErr != nil || info.IsDir() {
		if statErr != nil {
			return nil, fmt.Errorf("browser worker script: %w", statErr)
		}
		return nil, fmt.Errorf("browser worker script is a directory: %s", script)
	}
	node := strings.TrimSpace(os.Getenv("KIN_BROWSER_WORKER_NODE"))
	if node == "" {
		node = "node"
	}
	workingDir := strings.TrimSpace(os.Getenv("KIN_BROWSER_WORKER_WORKDIR"))
	if workingDir == "" {
		workingDir = filepath.Dir(script)
	}
	domains := make([]string, 0)
	for _, raw := range strings.Split(os.Getenv("KIN_BROWSER_DOMAINS"), ",") {
		if domain := strings.TrimSpace(raw); domain != "" {
			domains = append(domains, domain)
		}
	}
	return browserworker.New(browserworker.Config{
		Command:        []string{node, script},
		WorkingDir:     workingDir,
		AllowedDomains: domains,
		DownloadDir:    filepath.Join(stateDir, "browser-downloads"),
		UploadDir:      filepath.Join(stateDir, "browser-uploads"),
		ArtifactsDir:   filepath.Join(stateDir, "artifacts"),
		Store:          st,
		Engine:         eng,
		Bus:            bus,
	})
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
