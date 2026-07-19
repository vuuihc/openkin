package usagewindows

import (
	"net/http"
	"sort"
	"strconv"
)

// windowKind maps a window length in minutes to a stable label. 300 minutes is
// the 5-hour window; 10080 minutes (7 days) is the weekly window.
func windowKind(minutes int64) string {
	switch {
	case minutes <= 0:
		return ""
	case minutes <= 300:
		return "5h"
	default:
		return "weekly"
	}
}

// parseCodexHeaders builds a Provider from the x-codex-* response headers Codex
// returns on its responses endpoint. Missing/blank headers are skipped.
func parseCodexHeaders(h http.Header) Provider {
	prov := Provider{Provider: "codex", Plan: h.Get("x-codex-plan-type")}
	for _, prefix := range []string{"x-codex-primary", "x-codex-secondary"} {
		minutes := atoiHeader(h.Get(prefix + "-window-minutes"))
		kind := windowKind(minutes)
		if kind == "" {
			continue
		}
		pct := atofHeader(h.Get(prefix + "-used-percent"))
		prov.Windows = append(prov.Windows, Window{
			Kind:        kind,
			UsedPercent: pct,
			Status:      statusFromPercent(pct),
			ResetAt:     atoiHeader(h.Get(prefix + "-reset-at")),
		})
	}
	sortWindows(prov.Windows)
	return prov
}

// parseClaudeHeaders builds a Provider from the anthropic-ratelimit-unified-*
// response headers. Utilization is reported as a 0..1 fraction.
func parseClaudeHeaders(h http.Header, plan string) Provider {
	prov := Provider{Provider: "claude", Plan: plan}
	windows := []struct{ header, kind string }{
		{"anthropic-ratelimit-unified-5h", "5h"},
		{"anthropic-ratelimit-unified-7d", "weekly"},
	}
	for _, w := range windows {
		util := h.Get(w.header + "-utilization")
		if util == "" {
			continue
		}
		pct := atofHeader(util) * 100
		prov.Windows = append(prov.Windows, Window{
			Kind:        w.kind,
			UsedPercent: pct,
			Status:      statusFromPercent(pct),
			ResetAt:     atoiHeader(h.Get(w.header + "-reset")),
		})
	}
	sortWindows(prov.Windows)
	return prov
}

// sortWindows orders windows shortest-first (5h before weekly) for stable output.
func sortWindows(ws []Window) {
	rank := func(k string) int {
		if k == "5h" {
			return 0
		}
		return 1
	}
	sort.SliceStable(ws, func(i, j int) bool { return rank(ws[i].Kind) < rank(ws[j].Kind) })
}

func atoiHeader(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func atofHeader(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}
