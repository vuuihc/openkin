// Package detect discovers installed agent CLIs on PATH.
package detect

import (
	"os"
	"os/exec"
	"sort"
	"sync"
	"time"
)

// Info describes one known agent backend.
type Info struct {
	ID        string `json:"id"`        // kin agent key, e.g. "claude-code"
	Name      string `json:"name"`      // display name
	Binary    string `json:"binary"`    // resolved path when installed
	Installed bool   `json:"installed"` // binary found on PATH
	Available bool   `json:"available"` // ready to run (installed for now)
	Default   bool   `json:"default"`   // selected as default when agent omitted
	Reason    string `json:"reason,omitempty"`
}

// Spec is a known agent that Kin can drive if installed.
type Spec struct {
	ID     string
	Name   string
	Bins   []string // candidate binary names / env overrides
	EnvBin string   // e.g. KIN_CLAUDE_BIN
	// Priority: lower = preferred when picking default (0 = highest).
	Priority int
}

// Catalog is the built-in set of adapters Kin knows how to launch.
// Only installed entries are registered into the engine at serve time.
func Catalog() []Spec {
	return []Spec{
		{
			ID:       "claude-code",
			Name:     "Claude Code",
			Bins:     []string{"claude"},
			EnvBin:   "KIN_CLAUDE_BIN",
			Priority: 10,
		},
		{
			ID:       "codex",
			Name:     "Codex",
			Bins:     []string{"codex"},
			EnvBin:   "KIN_CODEX_BIN",
			Priority: 20,
		},
		{
			ID:       "grok",
			Name:     "Grok",
			Bins:     []string{"grok"},
			EnvBin:   "KIN_GROK_BIN",
			Priority: 30,
		},
	}
}

// LookPath is overridable in tests.
var LookPath = exec.LookPath

// Scan returns all catalog agents with install status.
// defaultID, if non-empty and installed, is marked Default; else first installed by priority.
func Scan(defaultID string) []Info {
	specs := Catalog()
	out := make([]Info, 0, len(specs))
	for _, sp := range specs {
		info := Info{
			ID:   sp.ID,
			Name: sp.Name,
		}
		path, reason := resolveBinary(sp)
		if path != "" {
			info.Binary = path
			info.Installed = true
			info.Available = true
		} else {
			info.Reason = reason
		}
		out = append(out, info)
	}

	// Pick default among available.
	chosen := ""
	if defaultID != "" {
		for _, i := range out {
			if i.ID == defaultID && i.Available {
				chosen = defaultID
				break
			}
		}
	}
	if chosen == "" {
		// lowest Priority among available
		bestP := int(^uint(0) >> 1)
		for _, sp := range specs {
			for _, i := range out {
				if i.ID == sp.ID && i.Available && sp.Priority < bestP {
					bestP = sp.Priority
					chosen = sp.ID
				}
			}
		}
	}
	for i := range out {
		if out[i].ID == chosen {
			out[i].Default = true
		}
	}

	// Stable order: available first (by priority), then unavailable.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Available != out[j].Available {
			return out[i].Available
		}
		pi, pj := priorityOf(out[i].ID), priorityOf(out[j].ID)
		if pi != pj {
			return pi < pj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// DefaultID returns the default available agent id, or "".
func DefaultID(defaultPref string) string {
	for _, i := range Scan(defaultPref) {
		if i.Default {
			return i.ID
		}
	}
	return ""
}

// AvailableIDs returns installed agent ids.
func AvailableIDs() []string {
	var ids []string
	for _, i := range Scan("") {
		if i.Available {
			ids = append(ids, i.ID)
		}
	}
	return ids
}

func resolveBinary(sp Spec) (path string, reason string) {
	if sp.EnvBin != "" {
		if v := os.Getenv(sp.EnvBin); v != "" {
			if p, err := LookPath(v); err == nil {
				return p, ""
			}
			// Allow absolute path even if LookPath fails on some systems.
			if _, err := os.Stat(v); err == nil {
				return v, ""
			}
			return "", sp.EnvBin + " set but not found"
		}
	}
	for _, b := range sp.Bins {
		if p, err := LookPath(b); err == nil {
			return p, ""
		}
	}
	return "", "not found on PATH"
}

func priorityOf(id string) int {
	for _, sp := range Catalog() {
		if sp.ID == id {
			return sp.Priority
		}
	}
	return 999
}

// Cache is an optional short-lived scan cache for hot paths.
type Cache struct {
	mu      sync.Mutex
	ttl     time.Duration
	at      time.Time
	pref    string
	results []Info
}

// NewCache returns a scan cache (default 5s TTL).
func NewCache(ttl time.Duration) *Cache {
	if ttl <= 0 {
		ttl = 5 * time.Second
	}
	return &Cache{ttl: ttl}
}

// Get returns cached or fresh scan results.
func (c *Cache) Get(defaultPref string) []Info {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.results != nil && c.pref == defaultPref && time.Since(c.at) < c.ttl {
		out := make([]Info, len(c.results))
		copy(out, c.results)
		return out
	}
	c.results = Scan(defaultPref)
	c.pref = defaultPref
	c.at = time.Now()
	out := make([]Info, len(c.results))
	copy(out, c.results)
	return out
}
