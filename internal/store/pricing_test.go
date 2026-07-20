package store

import (
	"strings"
	"testing"
)

func TestDefaultPriceTableIncludesGrokAndCodex(t *testing.T) {
	pt := DefaultPriceTable()
	for _, model := range []string{"gpt-5.1-codex", "grok-4.5", "grok-4", "o4-mini", "claude-sonnet-4-5"} {
		if _, ok := pt[model]; !ok {
			// claude-sonnet-4-5 may only resolve via alias path in ComputeCost if bare key missing
			if _, ok2 := pt.lookup(model); !ok2 {
				t.Fatalf("default table missing %q", model)
			}
		}
	}
	cost, ok := pt.ComputeCost("grok-4.5", 1_000_000, 1_000_000)
	if !ok {
		t.Fatal("ComputeCost grok-4.5 failed")
	}
	// LiteLLM snapshot at generation: in=2, out=6 → $8 / 1M+1M
	if cost < 7.9 || cost > 8.1 {
		t.Fatalf("grok-4.5 cost = %v, want ~8", cost)
	}
	// Provider prefix should still resolve.
	if _, ok := pt.ComputeCost("xai/grok-4.5", 1000, 0); !ok {
		t.Fatal("prefix lookup failed")
	}
}

func TestDefaultPriceTableJSONParses(t *testing.T) {
	if strings.TrimSpace(DefaultPriceTableJSON) == "" {
		t.Fatal("empty default json")
	}
	if _, err := ParsePriceTable(DefaultPriceTableJSON); err != nil {
		t.Fatal(err)
	}
}
