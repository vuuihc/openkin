package claudecode

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeModelListKeepsAliasesWhenNothingRewritesThem(t *testing.T) {
	models := claudeModelList(func(string) string { return "" })
	if len(models) != 3 {
		t.Fatalf("models = %+v", models)
	}
	for i, want := range []struct{ id, label string }{
		{"opus", "Opus"}, {"sonnet", "Sonnet"}, {"haiku", "Haiku"},
	} {
		if models[i].ID != want.id || models[i].Label != want.label {
			t.Fatalf("models[%d] = %+v, want %s/%s", i, models[i], want.id, want.label)
		}
	}
}

func TestClaudeModelListOffersWhatTheAliasesResolveTo(t *testing.T) {
	// A gateway setup: every alias lands on one model. Offering three rows
	// would let a person pick "Haiku" and be answered by something else.
	models := claudeModelList(func(string) string { return "codex/gpt-6.1-sol" })
	if len(models) != 1 {
		t.Fatalf("models = %+v", models)
	}
	if models[0].ID != "codex/gpt-6.1-sol" || models[0].Label != "codex/gpt-6.1-sol" {
		t.Fatalf("model = %+v", models[0])
	}
}

func TestClaudeModelListKeepsDistinctTargetsInOrder(t *testing.T) {
	env := map[string]string{
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   "a/one",
		"ANTHROPIC_DEFAULT_SONNET_MODEL": "b/two",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "a/one",
	}
	models := claudeModelList(func(key string) string { return env[key] })
	if len(models) != 2 {
		t.Fatalf("models = %+v", models)
	}
	if models[0].ID != "a/one" || models[1].ID != "b/two" {
		t.Fatalf("models = %+v", models)
	}
}

func TestClaudeSettingsEnvReadsBothFilesWithLocalWinning(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{
		"env": {"ANTHROPIC_DEFAULT_HAIKU_MODEL": "base/haiku", "KEEP": "base"}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.local.json"), []byte(`{
		"env": {"ANTHROPIC_DEFAULT_HAIKU_MODEL": "local/haiku"}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	env := claudeSettingsEnv()
	if env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] != "local/haiku" {
		t.Fatalf("haiku = %q, want the local override", env["ANTHROPIC_DEFAULT_HAIKU_MODEL"])
	}
	if env["KEEP"] != "base" {
		t.Fatalf("shared key = %q", env["KEEP"])
	}
}

func TestClaudeSettingsEnvIgnoresUnreadableSettings(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.local.json"), []byte(`{
		"env": {"ANTHROPIC_DEFAULT_OPUS_MODEL": "ok/opus"}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := claudeSettingsEnv()
	if env["ANTHROPIC_DEFAULT_OPUS_MODEL"] != "ok/opus" {
		t.Fatalf("env = %+v", env)
	}
}

func TestClaudeEnvLookupPrefersTheInheritedValue(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{
		"env": {"ANTHROPIC_DEFAULT_HAIKU_MODEL": "settings/haiku"}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "process/haiku")
	lookup := claudeEnvLookup()
	if got := lookup("ANTHROPIC_DEFAULT_HAIKU_MODEL"); got != "process/haiku" {
		t.Fatalf("lookup = %q, want the inherited value", got)
	}
	// A variable the daemon does not set still comes from the settings the
	// CLI will read.
	os.Unsetenv("ANTHROPIC_DEFAULT_HAIKU_MODEL")
	if got := lookup("ANTHROPIC_DEFAULT_HAIKU_MODEL"); got != "settings/haiku" {
		t.Fatalf("lookup without process value = %q", got)
	}
}
