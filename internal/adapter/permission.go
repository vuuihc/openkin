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
