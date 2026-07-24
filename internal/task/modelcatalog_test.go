package task

import "testing"

func TestCatalogNormalize(t *testing.T) {
	c := BuiltinCatalog()
	cases := []struct {
		agent, in, want string
		ok              bool
	}{
		{"claude-code", "opus", "claude-opus-4-8", true},
		{"claude-code", "Opus 4.8", "claude-opus-4-8", true},
		{"claude-code", "haiku", "claude-haiku-4-5", true},
		{"codex", "gpt 5.1 codex max", "gpt-5.1-codex-max", true},
		{"codex", "mini", "o4-mini", true},
		// Longest match wins: "gpt-5.1" must not collapse to gpt-5-codex.
		{"codex", "gpt-5.1-codex", "gpt-5.1-codex", true},
		// Unknown / future model → no match, caller keeps verbatim.
		{"codex", "gpt-5.6-terra", "", false},
		{"claude-code", "", "", false},
	}
	for _, tc := range cases {
		got, ok := c.Normalize(tc.agent, tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("Normalize(%q,%q) = (%q,%v), want (%q,%v)",
				tc.agent, tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestCatalogPickByTier(t *testing.T) {
	c := BuiltinCatalog()
	cases := []struct {
		agent string
		tier  ModelTier
		want  string
	}{
		{"claude-code", TierSmart, "claude-opus-4-8"},
		{"claude-code", TierFast, "claude-haiku-4-5"},
		{"codex", TierSmart, "gpt-5.1-codex-max"},
		{"codex", TierFast, "o4-mini"},
		{"grok", TierBalanced, "grok-3"},
	}
	for _, tc := range cases {
		got, ok := c.PickByTier(tc.agent, tc.tier)
		if !ok || got != tc.want {
			t.Errorf("PickByTier(%q,%q) = (%q,%v), want %q", tc.agent, tc.tier, got, ok, tc.want)
		}
	}
	// Unknown agent → no pick.
	if _, ok := c.PickByTier("nope", TierSmart); ok {
		t.Errorf("PickByTier(unknown) should be ok=false")
	}
}

func TestNormalizeTier(t *testing.T) {
	cases := map[string]ModelTier{
		"聪明": TierSmart, "贵": TierSmart, "smart": TierSmart,
		"便宜": TierFast, "cheap": TierFast, "快": TierFast,
		"balanced": TierBalanced, "均衡": TierBalanced,
		"": "", "weird": "",
	}
	for in, want := range cases {
		if got := NormalizeTier(in); got != want {
			t.Errorf("NormalizeTier(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCatalogTierOf(t *testing.T) {
	c := BuiltinCatalog()
	if got := c.TierOf("claude-code", "opus"); got != TierSmart {
		t.Fatalf("TierOf opus = %q want smart", got)
	}
	if got := c.TierOf("claude-code", "haiku"); got != TierFast {
		t.Fatalf("TierOf haiku = %q want fast", got)
	}
	if got := c.TierOf("kin", "opus"); got != "" {
		t.Fatalf("TierOf kin/opus = %q want empty", got)
	}
}
