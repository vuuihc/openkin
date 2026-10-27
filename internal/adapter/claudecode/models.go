package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/vuuihc/openkin/internal/agent"
)

// claudeModelAliases is the alias ladder the CLI accepts.
//
// The CLI does not treat these as model names: it resolves each one through
// ANTHROPIC_DEFAULT_*_MODEL, which a gateway setup routinely points at one
// model. Offering bare aliases made the console say "haiku" while a different
// model answered, so the list below is resolved to what will actually run.
var claudeModelAliases = []struct {
	ID    string
	Label string
	Env   string
}{
	{ID: "opus", Label: "Opus", Env: "ANTHROPIC_DEFAULT_OPUS_MODEL"},
	{ID: "sonnet", Label: "Sonnet", Env: "ANTHROPIC_DEFAULT_SONNET_MODEL"},
	{ID: "haiku", Label: "Haiku", Env: "ANTHROPIC_DEFAULT_HAIKU_MODEL"},
}

// claudeModelList resolves each alias against the environment the CLI will
// read, and keeps one entry per distinct result. An alias that resolves to a
// model is offered as that model; two aliases pointing at the same model are
// one choice, not two.
func claudeModelList(lookup func(string) string) []agent.ModelOption {
	out := make([]agent.ModelOption, 0, len(claudeModelAliases))
	seen := make(map[string]struct{}, len(claudeModelAliases))
	for _, alias := range claudeModelAliases {
		id := strings.TrimSpace(lookup(alias.Env))
		if id == "" {
			id = alias.ID
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		label := alias.Label
		if id != alias.ID {
			// The alias is not what runs; the resolved id is the only honest
			// name for this entry.
			label = id
		}
		out = append(out, agent.ModelOption{ID: id, Label: label})
	}
	return out
}

// claudeSettingsEnv reads the env block of the CLI's own settings files, which
// it applies at startup. That block is how a machine-wide gateway rewires the
// aliases, so it is the difference between advertising a model and advertising
// a word.
func claudeSettingsEnv() map[string]string {
	out := map[string]string{}
	dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return out
		}
		dir = filepath.Join(home, ".claude")
	}
	// settings.local.json is the per-machine override and is read second.
	for _, name := range []string{"settings.json", "settings.local.json"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var doc struct {
			Env map[string]string `json:"env"`
		}
		if json.Unmarshal(data, &doc) != nil {
			continue
		}
		for key, value := range doc.Env {
			out[key] = value
		}
	}
	return out
}

// claudeEnvLookup answers with the value the child CLI is most likely to use:
// the inherited process environment first, then the settings files. The node
// runs as the same user as the CLI, so both are visible here.
func claudeEnvLookup() func(string) string {
	settings := claudeSettingsEnv()
	return func(key string) string {
		if value, ok := os.LookupEnv(key); ok && strings.TrimSpace(value) != "" {
			return value
		}
		return settings[key]
	}
}
