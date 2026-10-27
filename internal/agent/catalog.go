package agent

import "strings"

// Transport names how a plugin reaches its agent. It is deliberately about the
// wire, not the product: the same product can be driven natively or over ACP,
// and a console that offers both as unrelated entries is asking the user to
// choose an implementation detail they cannot see.
const (
	TransportNative = "native"
	TransportACP    = "acp"
	TransportCLI    = "cli"
)

// families maps a plugin id to the product it drives. Ids absent from the table
// are their own family, which is the honest answer for the long tail of generic
// CLI agents: two entries are only collapsed when the products really are the
// same.
var families = map[string]string{
	"claude-code": "claude",
	"claude-acp":  "claude",
	"codex":       "codex",
	"codex-acp":   "codex",
	"droid":       "droid",
	"droid-acp":   "droid",
	"pi":          "pi",
	"pi-acp":      "pi",
}

// Family is the product an agent id drives, for grouping duplicates.
func Family(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if family, ok := families[id]; ok {
		return family
	}
	return id
}

// Transport classifies how an agent is driven. Kin's ACP entries all carry the
// `-acp` suffix by construction (see the acpAgents table); everything else is
// either a first-class adapter or a generic CLI invocation, which the plugin's
// own Kind already separates.
func Transport(id string, kind Kind) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if strings.HasSuffix(id, "-acp") {
		return TransportACP
	}
	if kind == KindBuiltin {
		return TransportNative
	}
	switch id {
	case "claude-code", "codex", "droid", "grok", "rawpty":
		return TransportNative
	default:
		return TransportCLI
	}
}
