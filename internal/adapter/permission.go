package adapter

// Session-level permission modes. Apply to every agent run in a task
// (main agent + multi-@ workers). Adapters map these to CLI flags.
const (
	// PermissionDefault asks before risky tools (Claude MCP bridge, Codex defaults).
	PermissionDefault = "default"
	// PermissionAcceptEdits auto-accepts file edits; other tools may still prompt.
	PermissionAcceptEdits = "accept_edits"
	// PermissionYOLO bypasses agent permission prompts (operator-trusted / sandboxed envs).
	PermissionYOLO = "yolo"
)

// NormalizePermissionMode returns a known mode or PermissionDefault.
func NormalizePermissionMode(mode string) string {
	switch mode {
	case PermissionAcceptEdits, PermissionYOLO, PermissionDefault:
		return mode
	case "acceptEdits", "accept-edits":
		return PermissionAcceptEdits
	case "bypass", "bypassPermissions", "dangerously-skip-permissions":
		return PermissionYOLO
	default:
		return PermissionDefault
	}
}

// ValidPermissionMode reports whether mode is a recognized value.
func ValidPermissionMode(mode string) bool {
	switch mode {
	case "", PermissionDefault, PermissionAcceptEdits, PermissionYOLO,
		"acceptEdits", "accept-edits", "bypass", "bypassPermissions":
		return true
	default:
		return false
	}
}

// autoApprover is implemented by an adapter that can say what a permission mode
// really does for its agent, rather than what the mode is called.
type autoApprover interface {
	AutoApprovesAll(mode string) bool
}

// AutoApprovesAll reports whether running a with mode leaves nobody able to
// approve anything: every tool call the agent makes executes unattended.
//
// The name of the mode is not enough to decide this, which is the whole reason
// the question is asked of the adapter. "accept_edits" is a graded mode for an
// agent that keeps an approval prompt — Claude Code still asks about commands,
// Codex stays sandboxed — but an agent with no approval channel of its own has
// nothing to grade: the only mode it accepts is accept_edits, and the flag
// behind it is the one yolo maps to (grok's --always-approve, the generic CLI
// table's --yolo / --yes-always / OPENCODE_YOLO). An adapter that knows the
// difference says so; one that does not is assumed to bypass on yolo alone.
func AutoApprovesAll(a Adapter, mode string) bool {
	if reporter, ok := a.(autoApprover); ok {
		return reporter.AutoApprovesAll(mode)
	}
	return NormalizePermissionMode(mode) == PermissionYOLO
}
