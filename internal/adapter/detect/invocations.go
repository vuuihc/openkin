package detect

// Invocation describes how Kin launches a Tier-2 generic CLI agent.
// Hand-maintained; do not generate. Keys must match SkillsDiscoveryCatalog IDs.
type Invocation struct {
	// Mode is "json" (NDJSON / single JSON object on stdout) or "text" (PTY).
	Mode string
	// BinCandidates overrides/extends DiscoverySpec.Bins when non-empty
	// (e.g. qodercli vs qoder). Empty → use DiscoverySpec.Bins only.
	BinCandidates []string
	// Args is the argv template after the binary. "{{prompt}}" is replaced with the task prompt.
	Args []string
	// ModelFlag, when non-empty, is appended as ModelFlag, model before Args when a model is set.
	ModelFlag string
	// CwdFlag, when non-empty, is appended as CwdFlag, cwd when the task has a working directory.
	CwdFlag string
	// AutoConfirmFlags are always appended (yolo / yes-always style).
	AutoConfirmFlags []string
	// AutoConfirmEnv is merged into the process environment for auto-approve modes.
	AutoConfirmEnv map[string]string
	// NeedsVerification marks known-but-unverified invocations: registered but not Available.
	// Default for all Tier-2 entries is true until a maintainer smoke-tests the launch line
	// (or a future in-app smoke probe persists success). Flip to false only after verification.
	NeedsVerification bool
}

// GenericInvocations returns the Tier-2 declarative launch table.
// Agents listed here are assembled as genericcli factories by the composition root.
// Every entry defaults to NeedsVerification: true so PATH presence alone never enables
// the agent in new-chat / task dispatch.
func GenericInvocations() map[string]Invocation {
	return map[string]Invocation{
		"gemini-cli": {
			Mode:              "json",
			Args:              []string{"--prompt", "{{prompt}}", "--output-format", "json"},
			ModelFlag:         "-m",
			AutoConfirmFlags:  []string{"--yolo"},
			NeedsVerification: true,
		},
		"qwen-code": {
			Mode:              "json",
			Args:              []string{"-p", "{{prompt}}", "--output-format", "json"},
			ModelFlag:         "-m",
			AutoConfirmFlags:  []string{"--yolo"},
			NeedsVerification: true,
		},
		"aider-desk": {
			Mode:              "text",
			Args:              []string{"--message", "{{prompt}}", "--no-show-release-notes"},
			ModelFlag:         "--model",
			AutoConfirmFlags:  []string{"--yes-always"},
			NeedsVerification: true,
		},
		"qoder": {
			Mode:              "json",
			BinCandidates:     []string{"qodercli", "qoder"},
			Args:              []string{"-p", "{{prompt}}", "--output-format=json"},
			AutoConfirmFlags:  []string{"--yolo"},
			NeedsVerification: true,
		},
		"opencode": {
			Mode:              "json",
			Args:              []string{"run", "{{prompt}}", "--format", "json"},
			ModelFlag:         "--model",
			AutoConfirmEnv:    map[string]string{"OPENCODE_YOLO": "true"},
			NeedsVerification: true,
		},
		"pi": {
			Mode:              "json",
			BinCandidates:     []string{"pi"},
			Args:              []string{"-p", "{{prompt}}", "--mode", "json"},
			NeedsVerification: true,
		},
	}
}

// IsGenericCLI reports whether id has a Tier-2 generic invocation entry.
func IsGenericCLI(id string) bool {
	_, ok := GenericInvocations()[id]
	return ok
}
