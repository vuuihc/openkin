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

// claudePickerOption is one row of the CLI's own `modelPicker`.
//
// Claude Code keeps the list of models a gateway offers in its settings file —
// `modelPicker.options[]` — which is what its own `/model` menu shows. The
// three aliases above are only three of those models, and on a gateway setup
// all three usually resolve to the same one, so reading the aliases alone is
// how a machine with thirty models ended up advertising a single row.
type claudePickerOption struct {
	Model string `json:"model"`
	Label string `json:"label"`
}

func (o claudePickerOption) id() string { return strings.TrimSpace(o.Model) }

// claudeSettings is the parts of the CLI's settings files this adapter reads.
type claudeSettings struct {
	Env    map[string]string
	Picker []claudePickerOption
	Model  string
}

// readClaudeSettings merges settings.json with settings.local.json, which is
// the per-machine override and wins key by key. A whole `modelPicker` or
// `model` in the local file replaces the base one: they are choices, not maps,
// and half of one file's list is not a coherent choice.
func readClaudeSettings() claudeSettings {
	out := claudeSettings{Env: map[string]string{}}
	dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return out
		}
		dir = filepath.Join(home, ".claude")
	}
	for _, name := range []string{"settings.json", "settings.local.json"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var doc struct {
			Env         map[string]string `json:"env"`
			Model       string            `json:"model"`
			ModelPicker struct {
				Options []claudePickerOption `json:"options"`
			} `json:"modelPicker"`
		}
		if json.Unmarshal(data, &doc) != nil {
			continue
		}
		for key, value := range doc.Env {
			out.Env[key] = value
		}
		if len(doc.ModelPicker.Options) > 0 {
			out.Picker = doc.ModelPicker.Options
		}
		if strings.TrimSpace(doc.Model) != "" {
			out.Model = strings.TrimSpace(doc.Model)
		}
	}
	return out
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

// claudeModels is what the console offers for this machine.
//
// Order matters: the CLI's own picker first, because that is the list the
// person already sees in `claude /model` and the labels are the gateway's own
// ("DeepSeek V4.1 Flash · volcengine-gw"). Then whatever the aliases resolve
// to, then the configured default, each only if the picker did not already
// name it — a model is one choice no matter how many settings mention it.
//
// A bare alias is only offered when the CLI has no picker of its own: "opus"
// is a word the CLI resolves, not a model, and the only place that word is one
// of the real choices is a plain install. That is decided by whether a picker
// exists, not by whether the list is still empty — a plain install whose
// settings.json pins a default model still accepts the other two aliases, and
// branching on emptiness shrank that machine's catalog to the one pinned row.
func claudeModels(settings claudeSettings) []agent.ModelOption {
	out := make([]agent.ModelOption, 0, len(settings.Picker)+len(claudeModelAliases)+1)
	seen := make(map[string]struct{}, cap(out))
	add := func(id, label string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, dup := seen[id]; dup {
			return
		}
		seen[id] = struct{}{}
		if strings.TrimSpace(label) == "" {
			label = id
		}
		out = append(out, agent.ModelOption{ID: id, Label: label})
	}
	lookup := claudeLookup(settings.Env)
	for _, option := range settings.Picker {
		add(option.id(), option.Label)
	}
	if len(settings.Picker) == 0 {
		for _, option := range claudeModelList(lookup) {
			add(option.ID, option.Label)
		}
	} else {
		// A gateway can rewire one alias without listing it in the picker; that
		// resolved id is still a model this machine will run.
		for _, alias := range claudeModelAliases {
			if id := strings.TrimSpace(lookup(alias.Env)); id != "" {
				add(id, id)
			}
		}
	}
	add(settings.Model, "")
	if len(out) == 0 {
		// A picker whose rows all lacked a model name says nothing; the ladder
		// is still true.
		return claudeModelList(lookup)
	}
	return out
}

// claudeLookup answers with the value the child CLI is most likely to use: the
// inherited process environment first, then the settings files. The node runs
// as the same user as the CLI, so both are visible here.
func claudeLookup(settings map[string]string) func(string) string {
	return func(key string) string {
		if value, ok := os.LookupEnv(key); ok && strings.TrimSpace(value) != "" {
			return value
		}
		return settings[key]
	}
}
