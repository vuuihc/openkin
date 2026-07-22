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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vuuihc/kin/internal/api"
	"github.com/vuuihc/kin/internal/notify"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/remote"
	remotetsnet "github.com/vuuihc/kin/internal/remote/tsnet"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
	"github.com/vuuihc/kin/internal/terminal"
	"github.com/vuuihc/kin/internal/usagewindows"
	"github.com/vuuihc/kin/internal/workspace"
	"github.com/vuuihc/kin/web"
)

const defaultPort = 7777

// ServeFlags are CLI options for `kin serve` (spec §7).
type ServeFlags struct {
	Port         int
	LAN          bool
	Tailscale    bool
	Funnel       bool
	TSControlURL string
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
	reg, err := buildAgentRegistry(ctx, st, daemonURL, tokenFn)
	if err != nil {
		return err
	}
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

	eng := task.NewEngine(st, reg, task.NewBus(), task.DefaultMaxConcurrent)
	wsMgr := workspace.NewManager(stateDir)
	eng.SetWorkspaceRuntime(wsMgr)
	defer eng.Close()
	eng.SetDefaultPreference(func(c context.Context) (string, error) {
		pref, err := st.GetSetting(c, "agent.default")
		return strings.TrimSpace(pref), err
	})
	if err := eng.Recover(context.Background()); err != nil {
		return err
	}
	eng.StartExpiryLoop(context.Background(), time.Minute)

	notifier := &notify.Sender{Store: st}
	eng.SetNotifier(notifier)
	// Session titles: truncate immediately, then replace via cognition provider when configured.
	eng.SetTitleResolver(func(c context.Context) (provider.Client, provider.Config, error) {
		cfg, err := provider.LoadConfig(c, st)
		if err != nil {
			return nil, cfg, err
		}
		if !cfg.Configured() {
			return nil, cfg, fmt.Errorf("provider not configured")
		}
		cli, err := provider.NewClient(cfg)
		return cli, cfg, err
	})

	static, err := uiHandler()
	if err != nil {
		return err
	}

	auth := remote.NewFileAuth(tokenPath)
	mode := networkMode(flags)
	terminals := newTerminalManager(terminal.DetectProfiles)
	defer terminals.Close()
	srvAPI := &api.Server{
		Store:        st,
		Auth:         auth,
		Engine:       eng,
		Workspace:    wsMgr,
		Terminals:    terminals,
		Version:      version,
		Static:       static,
		UploadsDir:   filepath.Join(stateDir, "uploads"),
		ArtifactsDir: filepath.Join(stateDir, "artifacts"),
		ProjectsDir:  filepath.Join(stateDir, "projects"),
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
		NetworkMode:  mode,
		// Probe provider subscription windows (5h/weekly) from the tokens the
		// Claude Code and Codex CLIs already store. Cached 60s to avoid
		// hammering providers (and spending Codex quota) on every page view.
		UsageWindows: usagewindows.New(60*time.Second, &usagewindows.ClaudeProber{}, &usagewindows.CodexProber{}),
		ListAgents: func() []api.AgentInfo {
			pref, _ := st.GetSetting(context.Background(), "agent.default")
			list := reg.List(context.Background(), strings.TrimSpace(pref))
			out := make([]api.AgentInfo, 0, len(list))
			for _, i := range list {
				caps := make([]string, 0, len(i.Capabilities))
				for _, c := range i.Capabilities {
					caps = append(caps, string(c))
				}
				out = append(out, api.AgentInfo{
					ID:           i.ID,
					Name:         i.Name,
					Kind:         string(i.Kind),
					Capabilities: caps,
					Binary:       i.Binary,
					Installed:    i.Installed,
					Available:    i.Available,
					Reason:       i.Reason,
					Default:      i.Default,
				})
			}
			return out
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
				_ = a.ln.Close()
			}
			return fmt.Errorf("%s: %w", tr.Name(), err)
		}
		a := listenerInfo{name: tr.Name(), ln: ln}
		switch tr.Name() {
		case "loopback":
			a.url = fmt.Sprintf("http://127.0.0.1:%d", port)
			a.qr = a.url + "/?token=" + auth.Token()
		case "lan":
			ip := remote.PrimaryLANIP()
			a.url = fmt.Sprintf("http://%s:%d", ip, port)
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
			a.qr = a.url + "/?token=" + auth.Token()
		}
		listeners = append(listeners, a)
	}

	// ui.base_url = most-public active listener (funnel > tsnet > lan > loopback).
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
	}
	fmt.Printf("  token file: %s\n", tokenPath)

	// Print QR for the most-public non-loopback URL; always print open link for loopback.
	qrURL := mostPublicQR(listeners)
	if qrURL != "" {
		fmt.Printf("  open: %s\n", qrURL)
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
			_ = a.ln.Close()
		}
		return err
	}

	listenCancel()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	for _, a := range listeners {
		_ = a.ln.Close()
	}
	wg.Wait()
	return nil
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
	qr   string // full URL with token for QR
}

// rank: funnel/tsnet https > tsnet > lan > loopback
func publicityRank(name, url string) int {
	if strings.HasPrefix(url, "https://") {
		return 4
	}
	switch name {
	case "tsnet":
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
