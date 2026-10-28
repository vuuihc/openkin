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

	env := readClaudeSettings().Env
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
	env := readClaudeSettings().Env
	if env["ANTHROPIC_DEFAULT_OPUS_MODEL"] != "ok/opus" {
		t.Fatalf("env = %+v", env)
	}
}

func TestClaudeLookupPrefersTheInheritedValue(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{
		"env": {"ANTHROPIC_DEFAULT_HAIKU_MODEL": "settings/haiku"}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "process/haiku")
	lookup := claudeLookup(readClaudeSettings().Env)
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

// clearClaudeAliasEnv keeps the developer's own gateway out of the test: the
// lookup prefers the inherited process environment, and a machine running
// these tests usually has the aliases exported.
func clearClaudeAliasEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"ANTHROPIC_DEFAULT_OPUS_MODEL",
		"ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	} {
		t.Setenv(key, "")
	}
}

func writeClaudeSettings(t *testing.T, name, body string) {
	t.Helper()
	clearClaudeAliasEnv(t)
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The picker is the CLI's own visible list, and its labels are the gateway's.
// Reading only the three aliases reported one model on a machine that offers
// dozens, because the aliases all resolved to the same id.
func TestClaudeModelsReadsTheCLIsOwnPicker(t *testing.T) {
	writeClaudeSettings(t, "settings.json", `{
		"model": "gw/big",
		"modelPicker": {"options": [
			{"model": "gw/big", "label": "Big · gw"},
			{"model": "gw/small", "label": "Small · gw"}
		]},
		"env": {
			"ANTHROPIC_DEFAULT_OPUS_MODEL": "gw/big",
			"ANTHROPIC_DEFAULT_SONNET_MODEL": "gw/big",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL": "gw/big"
		}
	}`)
	models := claudeModels(readClaudeSettings())
	want := []struct{ id, label string }{
		{"gw/big", "Big · gw"},
		{"gw/small", "Small · gw"},
	}
	if len(models) != len(want) {
		t.Fatalf("models = %+v", models)
	}
	for i, w := range want {
		if models[i].ID != w.id || models[i].Label != w.label {
			t.Fatalf("models[%d] = %+v, want %s/%s", i, models[i], w.id, w.label)
		}
	}
}

func TestClaudeModelsKeepsAnUnlistedDefaultAndAliasTargets(t *testing.T) {
	writeClaudeSettings(t, "settings.json", `{
		"model": "gw/default-only",
		"modelPicker": {"options": [{"model": "gw/picked", "label": "Picked"}]},
		"env": {"ANTHROPIC_DEFAULT_OPUS_MODEL": "gw/alias-only"}
	}`)
	models := claudeModels(readClaudeSettings())
	got := make([]string, len(models))
	for i, m := range models {
		got[i] = m.ID
	}
	want := []string{"gw/picked", "gw/alias-only", "gw/default-only"}
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids = %v, want %v", got, want)
		}
	}
}

// Pinning a default is not a picker. A plain install whose settings.json says
// `"model": "sonnet"` still accepts the other two aliases, but the ladder used
// to be the fallback for an empty list — so one pinned row replaced the whole
// catalog on exactly the machines that had configured something.
func TestClaudeModelsKeepsTheAliasLadderWhenOnlyADefaultIsPinned(t *testing.T) {
	writeClaudeSettings(t, "settings.json", `{"model": "sonnet"}`)
	models := claudeModels(readClaudeSettings())
	got := make([]string, len(models))
	for i, m := range models {
		got[i] = m.ID
	}
	want := []string{"opus", "sonnet", "haiku"}
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids = %v, want %v", got, want)
		}
	}
}

func TestClaudeModelsPrefersTheLocalPicker(t *testing.T) {
	clearClaudeAliasEnv(t)
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{
		"modelPicker": {"options": [{"model": "base/one", "label": "Base"}]}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.local.json"), []byte(`{
		"modelPicker": {"options": [{"model": "local/one", "label": "Local"}]}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := claudeModels(readClaudeSettings())
	if len(models) != 1 || models[0].ID != "local/one" || models[0].Label != "Local" {
		t.Fatalf("models = %+v, want the local picker alone", models)
	}
}
