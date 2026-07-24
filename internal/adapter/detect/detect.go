// Package detect discovers installed coding agents on the local machine.
//
// Two catalogs are maintained:
//
//   - Catalog / Scan: Kin-runnable adapters (claude-code, codex, grok, …) via PATH.
//   - SkillsDiscoveryCatalog / ScanPresence: broader skills-ecosystem list
//     (vercel-labs/skills AGENTS table) via PATH and/or well-known config dirs.
//
// Presence is used when switching the default host (agent.default): an id may
// only be selected when it is both registered as a Kin adapter and Available.
package detect

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// LookPath is overridable in tests (defaults to exec.LookPath).
var LookPath = exec.LookPath

// HomeDir is overridable in tests (defaults to os.UserHomeDir).
var HomeDir = os.UserHomeDir

// ConfigHome returns the XDG config directory (~/.config or $XDG_CONFIG_HOME).
// Overridable in tests.
var ConfigHome = func() string {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return v
	}
	home, err := HomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".config")
}

// Info describes one known agent backend (Kin-runnable catalog).
type Info struct {
	ID        string `json:"id"`        // kin agent key, e.g. "claude-code"
	Name      string `json:"name"`      // display name
	Binary    string `json:"binary"`    // resolved path when installed
	Installed bool   `json:"installed"` // binary found on PATH
	Available bool   `json:"available"` // ready to run (installed for now)
	Default   bool   `json:"default"`   // selected as default when agent omitted
	Reason    string `json:"reason,omitempty"`
}

// Presence is one discovery result from the skills-ecosystem catalog.
type Presence struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Binary       string `json:"binary,omitempty"`
	Installed    bool   `json:"installed"` // binary and/or config dir present
	Available    bool   `json:"available"` // same as Installed for discovery
	RunnableHint bool   `json:"runnable_hint"`
	Default      bool   `json:"default,omitempty"`
	Reason       string `json:"reason,omitempty"`
	Source       string `json:"source,omitempty"` // "binary" | "config" | "binary+config"
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
// Derived from SkillsDiscoveryCatalog entries with RunnableHint (plus grok).
func Catalog() []Spec {
	generic := GenericInvocations()
	var out []Spec
	for _, d := range SkillsDiscoveryCatalog() {
		if !d.RunnableHint {
			if _, ok := generic[d.ID]; !ok {
				continue
			}
		}
		bins := append([]string(nil), d.Bins...)
		if inv, ok := generic[d.ID]; ok && len(inv.BinCandidates) > 0 {
			bins = append([]string(nil), inv.BinCandidates...)
		}
		out = append(out, Spec{
			ID:       d.ID,
			Name:     d.Name,
			Bins:     bins,
			EnvBin:   d.EnvBin,
			Priority: d.Priority,
		})
	}
	if len(out) == 0 {
		// Fallback if catalog is empty (should not happen).
		return []Spec{
			{ID: "claude-code", Name: "Claude Code", Bins: []string{"claude"}, EnvBin: "KIN_CLAUDE_BIN", Priority: 10},
			{ID: "codex", Name: "Codex", Bins: []string{"codex"}, EnvBin: "KIN_CODEX_BIN", Priority: 20},
			{ID: "grok", Name: "Grok", Bins: []string{"grok"}, EnvBin: "KIN_GROK_BIN", Priority: 30},
		}
	}
	return out
}

// Scan returns live status for Catalog agents (PATH / env bin only).
// defaultPref, when non-empty and available, is marked Default; otherwise the
// lowest-priority available agent is default.
func Scan(defaultPref string) []Info {
	specs := Catalog()
	out := make([]Info, 0, len(specs))
	for _, sp := range specs {
		path, reason := resolveBinary(sp.EnvBin, sp.Bins)
		inst := path != ""
		available := inst
		if inv, ok := GenericInvocations()[sp.ID]; ok && inv.NeedsVerification && inst {
			available = false
			reason = "detected; awaiting Kin maintainer smoke test before enabling"
		}
		info := Info{
			ID:        sp.ID,
			Name:      sp.Name,
			Binary:    path,
			Installed: inst,
			Available: available,
			Reason:    reason,
		}
		if !inst && reason == "" {
			info.Reason = "not found on PATH"
		}
		out = append(out, info)
	}
	markDefaultInfo(out, defaultPref)
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := priorityOf(out[i].ID), priorityOf(out[j].ID)
		if pi != pj {
			return pi < pj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// ScanPresence returns local presence for the skills discovery catalog.
// An agent is Installed when a binary resolves and/or a known config directory exists.
func ScanPresence(defaultPref string) []Presence {
	specs := SkillsDiscoveryCatalog()
	out := make([]Presence, 0, len(specs))
	for _, sp := range specs {
		binPath, binReason := resolveBinary(sp.EnvBin, sp.Bins)
		configHit, configPath := resolveConfigPresence(sp)
		inst := binPath != "" || configHit
		src := ""
		switch {
		case binPath != "" && configHit:
			src = "binary+config"
		case binPath != "":
			src = "binary"
		case configHit:
			src = "config"
		}
		reason := ""
		if !inst {
			if binReason != "" {
				reason = binReason
			} else if len(sp.Bins) > 0 || len(sp.HomeDirs) > 0 || len(sp.ConfigDirs) > 0 {
				reason = "not found on PATH or known config dirs"
			} else {
				reason = "no detection signals"
			}
		} else if binPath == "" && configHit {
			reason = "config present (" + configPath + "); CLI binary not on PATH"
		}
		out = append(out, Presence{
			ID:           sp.ID,
			Name:         sp.Name,
			Binary:       binPath,
			Installed:    inst,
			Available:    inst,
			RunnableHint: sp.RunnableHint,
			Reason:       reason,
			Source:       src,
		})
	}
	markDefaultPresence(out, defaultPref)
	sort.SliceStable(out, func(i, j int) bool {
		// Runnable + installed first, then priority, then id.
		ai, aj := scorePresence(out[i]), scorePresence(out[j])
		if ai != aj {
			return ai < aj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func scorePresence(p Presence) int {
	// lower is better
	s := 1000
	if p.Installed {
		s -= 500
	}
	if p.RunnableHint {
		s -= 200
	}
	for _, d := range SkillsDiscoveryCatalog() {
		if d.ID == p.ID {
			s += d.Priority
			break
		}
	}
	return s
}

// DefaultID returns the default available agent id from Catalog, or "".
func DefaultID(defaultPref string) string {
	for _, i := range Scan(defaultPref) {
		if i.Default {
			return i.ID
		}
	}
	return ""
}

// AvailableIDs returns installed Catalog agent ids.
func AvailableIDs() []string {
	var ids []string
	for _, i := range Scan("") {
		if i.Available {
			ids = append(ids, i.ID)
		}
	}
	return ids
}

// IsLocallyPresent reports whether id is present on this machine via the
// discovery catalog (binary and/or config dir).
func IsLocallyPresent(id string) bool {
	id = trimID(id)
	if id == "" {
		return false
	}
	for _, p := range ScanPresence("") {
		if p.ID == id {
			return p.Installed
		}
	}
	// Also accept pure Catalog PATH hits for ids not in skills list.
	for _, i := range Scan("") {
		if i.ID == id {
			return i.Installed
		}
	}
	return false
}

func trimID(id string) string {
	for len(id) > 0 && (id[0] == ' ' || id[0] == '\t') {
		id = id[1:]
	}
	for len(id) > 0 && (id[len(id)-1] == ' ' || id[len(id)-1] == '\t') {
		id = id[:len(id)-1]
	}
	return id
}

func markDefaultInfo(out []Info, defaultPref string) {
	pref := trimID(defaultPref)
	if pref != "" {
		for i := range out {
			if out[i].ID == pref && out[i].Available {
				out[i].Default = true
				return
			}
		}
	}
	// First available by current order (caller sorts by priority).
	best := -1
	bestPri := 1 << 30
	for i := range out {
		if !out[i].Available {
			continue
		}
		p := priorityOf(out[i].ID)
		if p < bestPri {
			bestPri = p
			best = i
		}
	}
	if best >= 0 {
		out[best].Default = true
	}
}

func markDefaultPresence(out []Presence, defaultPref string) {
	pref := trimID(defaultPref)
	if pref != "" {
		for i := range out {
			if out[i].ID == pref && out[i].Available {
				out[i].Default = true
				return
			}
		}
	}
	best := -1
	bestScore := 1 << 30
	for i := range out {
		if !out[i].Available || !out[i].RunnableHint {
			continue
		}
		s := scorePresence(out[i])
		if s < bestScore {
			bestScore = s
			best = i
		}
	}
	if best >= 0 {
		out[best].Default = true
	}
}

func priorityOf(id string) int {
	for _, sp := range Catalog() {
		if sp.ID == id {
			return sp.Priority
		}
	}
	return 999
}

func resolveBinary(envBin string, bins []string) (path string, reason string) {
	if envBin != "" {
		if v := os.Getenv(envBin); v != "" {
			if p, err := LookPath(v); err == nil {
				return p, ""
			}
			// Allow absolute path even if LookPath fails on some systems.
			if _, err := os.Stat(v); err == nil {
				return v, ""
			}
			return "", envBin + " set but not found"
		}
	}
	for _, b := range bins {
		if b == "" {
			continue
		}
		if p, err := LookPath(b); err == nil {
			return p, ""
		}
	}
	return "", ""
}

func resolveConfigPresence(sp DiscoverySpec) (ok bool, hit string) {
	home, err := HomeDir()
	if err != nil {
		home = ""
	}
	if home != "" {
		for _, rel := range sp.HomeDirs {
			if rel == "" {
				continue
			}
			p := filepath.Join(home, rel)
			if dirExists(p) {
				return true, p
			}
		}
	}
	cfg := ConfigHome()
	if cfg != "" {
		for _, rel := range sp.ConfigDirs {
			if rel == "" {
				continue
			}
			p := filepath.Join(cfg, rel)
			if dirExists(p) {
				return true, p
			}
		}
	}
	return false, ""
}

func dirExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
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
