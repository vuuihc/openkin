// Package usagewindows reads the subscription rate-limit windows (5h + weekly)
// that the Claude Code and Codex CLIs are subject to, by reusing the OAuth
// tokens those CLIs already store on this machine.
//
// The window figures are not available from the CLIs as a machine-readable
// command; they are only returned as HTTP response headers on the providers'
// own endpoints (anthropic-ratelimit-unified-* for Claude, x-codex-* for
// Codex). This package makes one minimal authenticated probe per provider and
// parses those headers. It is best-effort and display-only: the tokens are read
// but never refreshed (the CLIs own their refresh), and any failure surfaces as
// a per-provider error rather than blocking anything.
package usagewindows

import (
	"context"
	"sync"
	"time"
)

// Window is one rate-limit window's used-vs-limit status.
type Window struct {
	// Kind is a stable label: "5h" or "weekly".
	Kind string `json:"kind"`
	// UsedPercent is 0..100 (may exceed 100 conceptually; providers cap at 100).
	UsedPercent float64 `json:"used_percent"`
	// Status is ok|warn|over derived from UsedPercent.
	Status string `json:"status"`
	// ResetAt is the unix epoch (seconds) when the window resets; 0 if unknown.
	ResetAt int64 `json:"reset_at"`
}

// Provider is the window status for one CLI's subscription.
type Provider struct {
	// Provider is "claude" or "codex".
	Provider string `json:"provider"`
	// Plan is the subscription tier when known (e.g. "pro", "plus").
	Plan string `json:"plan,omitempty"`
	// Windows is the set of active windows, sorted shortest-first.
	Windows []Window `json:"windows"`
	// Error is a human-readable reason the probe failed (token missing,
	// network error, expired token). Empty on success.
	Error string `json:"error,omitempty"`
	// UpdatedAt is when this snapshot was probed (unix seconds).
	UpdatedAt int64 `json:"updated_at"`
}

// Prober probes one provider's window status.
type Prober interface {
	// ID is the stable provider id ("claude" | "codex").
	ID() string
	// Probe returns the current window status. A returned error is folded into
	// Provider.Error by the Service; probers may also return a populated
	// Provider with Error set and a nil error.
	Probe(ctx context.Context) (Provider, error)
}

// statusFromPercent maps a used percentage to ok|warn|over using the same
// thresholds as the per-agent usage limits (80% warn, 100% over).
func statusFromPercent(pct float64) string {
	switch {
	case pct >= 100:
		return "over"
	case pct >= 80:
		return "warn"
	default:
		return "ok"
	}
}

type cacheEntry struct {
	provider Provider
	at       time.Time
}

// Service probes providers on demand and caches each result for a TTL so that
// viewing the Usage page does not hammer the providers (and, for Codex, does
// not spend quota on every poll).
type Service struct {
	probers []Prober
	ttl     time.Duration
	now     func() time.Time

	mu    sync.Mutex
	cache map[string]cacheEntry
}

// New builds a Service. ttl<=0 disables caching (probe every call).
func New(ttl time.Duration, probers ...Prober) *Service {
	return &Service{
		probers: probers,
		ttl:     ttl,
		now:     time.Now,
		cache:   make(map[string]cacheEntry),
	}
}

// Statuses returns one Provider per configured prober, using cached values that
// are still within the TTL. Providers are returned in prober order.
func (s *Service) Statuses(ctx context.Context) []Provider {
	out := make([]Provider, 0, len(s.probers))
	for _, p := range s.probers {
		out = append(out, s.status(ctx, p))
	}
	return out
}

func (s *Service) status(ctx context.Context, p Prober) Provider {
	now := s.now()
	if s.ttl > 0 {
		s.mu.Lock()
		if e, ok := s.cache[p.ID()]; ok && now.Sub(e.at) < s.ttl {
			s.mu.Unlock()
			return e.provider
		}
		s.mu.Unlock()
	}

	prov, err := p.Probe(ctx)
	if prov.Provider == "" {
		prov.Provider = p.ID()
	}
	if err != nil && prov.Error == "" {
		prov.Error = err.Error()
	}
	prov.UpdatedAt = now.Unix()

	if s.ttl > 0 {
		s.mu.Lock()
		s.cache[p.ID()] = cacheEntry{provider: prov, at: now}
		s.mu.Unlock()
	}
	return prov
}
