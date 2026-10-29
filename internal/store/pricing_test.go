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

func TestDefaultPriceTableCarriesContextWindows(t *testing.T) {
	pt := DefaultPriceTable()
	// The models the built-in catalog resolves to must have a window, or the
	// console's context meter has no denominator for the agents it ships for.
	cases := map[string]int64{
		"claude-opus-4-8":   1_000_000,
		"claude-sonnet-4-6": 1_000_000,
		"claude-haiku-4-5":  200_000,
		"gpt-5.1-codex":     400_000,
		"gpt-5.1-codex-max": 400_000,
		"gpt-5-codex":       272_000,
		"o4-mini":           200_000,
		"claude-sonnet-4-5": 200_000,
		// Retired ids upstream no longer lists. They keep their row, and the
		// generator supplies the window from KEPT_CTX; without it an old
		// session pinned to one would draw no meter at all.
		"claude-opus-4-1":            200_000,
		"claude-sonnet-4-20250514":   200_000,
		"claude-3-7-sonnet-20250219": 200_000,
	}
	for model, want := range cases {
		got, ok := pt.ContextWindow(model)
		if !ok || got != want {
			t.Fatalf("ContextWindow(%q) = %d, %v; want %d, true", model, got, ok, want)
		}
	}
}

func TestContextWindowLookupRules(t *testing.T) {
	pt := PriceTable{
		"gpt-x":     {In: 1, Out: 2, Ctx: 400_000},
		"no-window": {In: 1, Out: 2},
	}
	if w, ok := pt.ContextWindow("gpt-x"); !ok || w != 400_000 {
		t.Fatalf("exact = %d, %v", w, ok)
	}
	// Same alias rules as pricing: a provider prefix resolves to the bare id.
	if w, ok := pt.ContextWindow("openai/gpt-x"); !ok || w != 400_000 {
		t.Fatalf("prefixed = %d, %v", w, ok)
	}
	if w, ok := pt.ContextWindow("GPT-X"); !ok || w != 400_000 {
		t.Fatalf("case-insensitive = %d, %v", w, ok)
	}
	// An entry without the field is unknown, not zero: callers must not draw
	// a meter whose denominator is a made-up zero.
	if w, ok := pt.ContextWindow("no-window"); ok || w != 0 {
		t.Fatalf("no-window = %d, %v; want 0, false", w, ok)
	}
	if _, ok := pt.ContextWindow("absent"); ok {
		t.Fatal("absent model reported a window")
	}
	var nilTable PriceTable
	if _, ok := nilTable.ContextWindow("gpt-x"); ok {
		t.Fatal("nil table reported a window")
	}
}

func TestParsePriceTableRejectsNegativeContext(t *testing.T) {
	if _, err := ParsePriceTable(`{"gpt-x":{"in":1,"out":2,"ctx":-1}}`); err == nil {
		t.Fatal("negative ctx accepted")
	}
	// The field is optional: a hand-written override with prices only is still
	// a valid table, and its models simply have no known window.
	pt, err := ParsePriceTable(`{"gpt-x":{"in":1,"out":2}}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := pt.ContextWindow("gpt-x"); ok {
		t.Fatal("entry without ctx reported a window")
	}
}

func TestDefaultPriceTableKeepsRetiredModels(t *testing.T) {
	// Upstream prunes ids as providers retire and rename them, and the
	// generator keeps the previous row rather than deleting it: a session
	// pinned to one of these still needs a price, and losing the row turns
	// every cost for it into a silent zero. Regenerating is what could break
	// this, so it is checked on the committed table.
	pt := DefaultPriceTable()
	for _, model := range []string{
		"claude-opus-4-1",
		"claude-sonnet-4-20250514",
		"claude-3-7-sonnet-20250219",
		"grok-4",
		"grok-4.5",
		"grok-2",
	} {
		if _, ok := pt[model]; !ok {
			t.Fatalf("default table dropped retired model %q", model)
		}
	}
}
