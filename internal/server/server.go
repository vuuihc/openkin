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

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/claudecode"
	"github.com/vuuihc/kin/internal/adapter/codex"
	"github.com/vuuihc/kin/internal/adapter/detect"
	"github.com/vuuihc/kin/internal/adapter/grok"
	"github.com/vuuihc/kin/internal/adapter/kinagent"
	"github.com/vuuihc/kin/internal/adapter/rawpty"
	"github.com/vuuihc/kin/internal/api"
	"github.com/vuuihc/kin/internal/notify"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/remote"
	remotetsnet "github.com/vuuihc/kin/internal/remote/tsnet"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
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

	daemonURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	// Discover installed agent CLIs and only register those present on PATH.
	// Optional preference: settings key agent.default.
	defaultPref, _ := st.GetSetting(ctx, "agent.default")
	found := detect.Scan(defaultPref)
	adapters := map[string]adapter.Adapter{}
	for _, info := range found {
		if !info.Available {
			fmt.Printf("agent %s: not installed (%s)\n", info.ID, info.Reason)
			continue
		}
		switch info.ID {
		case "claude-code":
			claudeAd := claudecode.New()
			claudeAd.Binary = info.Binary
			claudeAd.DaemonURL = daemonURL
			claudeAd.Token = token
			claudeAd.TokenFunc = func() string {
				t, err := remote.ReadToken(stateDir)
				if err != nil || t == "" {
					return token
				}
				return t
			}
			adapters["claude-code"] = claudeAd
			fmt.Printf("agent claude-code: %s\n", info.Binary)
		case "codex":
			codexAd := codex.New()
			codexAd.Binary = info.Binary
			adapters["codex"] = codexAd
			fmt.Printf("agent codex: %s\n", info.Binary)
		case "grok":
			grokAd := grok.New()
			grokAd.Binary = info.Binary
			adapters["grok"] = grokAd
			fmt.Printf("agent grok: %s\n", info.Binary)
		}
	}
	// rawpty is opt-in (not auto-discovered as a coding agent).
	if os.Getenv("KIN_ENABLE_RAWPTY") == "1" {
		adapters["rawpty"] = rawpty.New()
		fmt.Println("agent rawpty: enabled (KIN_ENABLE_RAWPTY=1)")
	}

	// Built-in Kin agent = Kin + cognition Provider (always registered).
	// Available for runs when provider.base_url + provider.model are set.
	// Durable multi-turn transcript + session_search over events (ADR 0002 P1.5/P2).
	kinBridge := kinagent.StoreTranscript{Store: st}
	kinAd := kinagent.New(func(c context.Context) (provider.Client, provider.Config, error) {
		cfg, err := provider.LoadConfig(c, st)
		if err != nil {
			return nil, cfg, err
		}
		if !cfg.Configured() {
			return nil, cfg, fmt.Errorf("provider not configured (Settings → Cognition)")
		}
		cli, err := provider.NewClient(cfg)
		return cli, cfg, err
	})
	kinAd.Transcript = kinBridge
	kinAd.Search = kinBridge
	adapters[kinagent.AgentID] = kinAd
	if cfg, err := provider.LoadConfig(ctx, st); err == nil && cfg.Configured() {
		fmt.Printf("agent kin: provider %s model=%s\n", cfg.BaseURL, cfg.Model)
	} else {
		fmt.Println("agent kin: registered (configure provider in Settings to enable)")
	}

	if len(adapters) == 0 {
		return fmt.Errorf("no agents available")
	}

	eng := task.NewEngine(st, adapters, task.NewBus(), task.DefaultMaxConcurrent)
	defer eng.Close()
	// Default agent: agent.default setting if available; else kin when provider ready; else first CLI.
	eng.SetDefaultAgentFn(func() string {
		pref, _ := st.GetSetting(context.Background(), "agent.default")
		pref = strings.TrimSpace(pref)
		pcfg, _ := provider.LoadConfig(context.Background(), st)
		kinReady := pcfg.Configured() && eng.HasAgent(kinagent.AgentID)
		if pref != "" {
			if pref == kinagent.AgentID && kinReady {
				return kinagent.AgentID
			}
			if pref != kinagent.AgentID && eng.HasAgent(pref) {
				return pref
			}
		}
		if kinReady {
			return kinagent.AgentID
		}
		for _, id := range []string{"claude-code", "codex", "grok"} {
			if eng.HasAgent(id) {
				return id
			}
		}
		return ""
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
	agentCache := detect.NewCache(5 * time.Second)
	srvAPI := &api.Server{
		Store:        st,
		Auth:         auth,
		Engine:       eng,
		Version:      version,
		Static:       static,
		UploadsDir:   filepath.Join(stateDir, "uploads"),
		ArtifactsDir: filepath.Join(stateDir, "artifacts"),
		NetworkMode:  mode,
		ListAgents: func() []api.AgentInfo {
			pref, _ := st.GetSetting(context.Background(), "agent.default")
			list := agentCache.Get(pref)
			out := make([]api.AgentInfo, 0, len(list)+1)

			// Kin + Provider first-class agent.
			pcfg, _ := provider.LoadConfig(context.Background(), st)
			kinOK := pcfg.Configured() && eng.HasAgent(kinagent.AgentID)
			kinInfo := api.AgentInfo{
				ID:        kinagent.AgentID,
				Name:      "Kin",
				Installed: true,
				Available: kinOK,
				Binary:    pcfg.BaseURL,
			}
			if !kinOK {
				kinInfo.Reason = "configure provider.base_url + provider.model in Settings"
			}
			out = append(out, kinInfo)

			for _, i := range list {
				reg := eng.HasAgent(i.ID)
				out = append(out, api.AgentInfo{
					ID:        i.ID,
					Name:      i.Name,
					Binary:    i.Binary,
					Installed: i.Installed,
					Available: reg,
					Reason:    i.Reason,
				})
			}
			def := eng.DefaultAgent()
			for i := range out {
				out[i].Default = out[i].ID == def && out[i].Available
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
