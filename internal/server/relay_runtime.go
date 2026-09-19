package server

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/api"
	"github.com/vuuihc/openkin/internal/remote/relay"
	"github.com/vuuihc/openkin/internal/store"
)

// relayRuntime owns the optional outbound Relay connection for the lifetime of
// a daemon. Keeping it process-local lets Settings turn remote access on or
// off without restarting the HTTP server or asking users to run a command.
type relayRuntime struct {
	mu       sync.Mutex
	opMu     sync.Mutex
	parent   context.Context
	stateDir string
	localURL string
	store    *store.Store
	token    func() string

	cancel  context.CancelFunc
	bridge  *relay.Bridge
	url     string
	pairing string
}

func newRelayRuntime(
	parent context.Context,
	stateDir string,
	localURL string,
	st *store.Store,
	token func() string,
) *relayRuntime {
	return &relayRuntime{
		parent:   parent,
		stateDir: stateDir,
		localURL: localURL,
		store:    st,
		token:    token,
	}
}

func (r *relayRuntime) Configure(ctx context.Context, rawURL string) (api.RelayStatus, error) {
	r.opMu.Lock()
	defer r.opMu.Unlock()

	rawURL = strings.TrimSpace(rawURL)
	if rawURL != "" {
		if err := relay.ValidateURL(rawURL); err != nil {
			return api.RelayStatus{}, err
		}
	}

	if rawURL == "" {
		r.mu.Lock()
		oldCancel := r.cancel
		r.cancel = nil
		r.bridge = nil
		r.url = ""
		r.pairing = ""
		r.mu.Unlock()
		if oldCancel != nil {
			// Let a Settings request arriving through the old Relay finish
			// before closing its transport.
			time.AfterFunc(2*time.Second, oldCancel)
		}
		return r.Snapshot(), nil
	}

	bridge, err := relay.NewPersistentBridge(rawURL, r.stateDir, r.localURL)
	if err != nil {
		return api.RelayStatus{}, fmt.Errorf("initialize relay: %w", err)
	}
	token := ""
	if r.token != nil {
		token = r.token()
	}
	pairing, err := issuePairingURL(ctx, r.store, bridge.ConnectURLWithKey()+"&token="+token, "relay")
	if err != nil {
		return api.RelayStatus{}, err
	}
	runCtx, cancel := context.WithCancel(r.parent)
	r.mu.Lock()
	oldCancel := r.cancel
	r.cancel = cancel
	r.bridge = bridge
	r.url = rawURL
	r.pairing = pairing
	r.mu.Unlock()
	if oldCancel != nil {
		// Reconfiguration may itself be carried by the old Relay bridge.
		time.AfterFunc(2*time.Second, oldCancel)
	}

	go func() {
		_ = bridge.Run(runCtx)
	}()
	return r.Snapshot(), nil
}

func (r *relayRuntime) RefreshPairing(ctx context.Context) (api.RelayStatus, error) {
	r.opMu.Lock()
	defer r.opMu.Unlock()

	r.mu.Lock()
	bridge := r.bridge
	r.mu.Unlock()
	if bridge == nil {
		return api.RelayStatus{}, fmt.Errorf("relay is not configured")
	}
	token := ""
	if r.token != nil {
		token = r.token()
	}
	pairing, err := issuePairingURL(ctx, r.store, bridge.ConnectURLWithKey()+"&token="+token, "relay")
	if err != nil {
		return api.RelayStatus{}, err
	}
	r.mu.Lock()
	r.pairing = pairing
	r.mu.Unlock()
	return r.Snapshot(), nil
}

func (r *relayRuntime) Snapshot() api.RelayStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	status := api.RelayStatus{
		URL:        r.url,
		ConnectURL: "",
		PairingURL: r.pairing,
	}
	if r.bridge == nil {
		status.State = "disabled"
		return status
	}
	status.ConnectURL = r.bridge.ConnectURL()
	token := ""
	if r.token != nil {
		token = r.token()
	}
	status.OpenURL = r.bridge.ConnectURLWithKey() + "&token=" + token
	if r.bridge.Connected() {
		status.State = "connected"
	} else if err := r.bridge.LastError(); err != "" {
		status.State = "error"
		status.LastError = err
	} else {
		status.State = "connecting"
	}
	return status
}

func (r *relayRuntime) Stop() {
	r.opMu.Lock()
	defer r.opMu.Unlock()

	r.mu.Lock()
	cancel := r.cancel
	r.cancel = nil
	r.bridge = nil
	r.url = ""
	r.pairing = ""
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// BaseURL returns the Relay's public HTTP origin without room credentials.
func (r *relayRuntime) BaseURL() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	raw := r.url
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "ws://") {
		raw = "http://" + strings.TrimPrefix(raw, "ws://")
	} else if strings.HasPrefix(raw, "wss://") {
		raw = "https://" + strings.TrimPrefix(raw, "wss://")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}
