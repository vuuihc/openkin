package detect

// Invocation describes how Kin launches a Tier-2 generic CLI agent.
// Hand-maintained; do not generate. Keys must match SkillsDiscoveryCatalog IDs.
type Invocation struct {
	// Mode is "json" (NDJSON / single JSON object on stdout) or "text" (PTY).
	Mode string
	// BinCandidates overrides/extends DiscoverySpec.Bins when non-empty
	// (e.g. qoder → qodercli, qoder).
	BinCandidates []string
	// Args is an argv template. Tokens: {{prompt}} {{model}}.
	Args []string
	// ModelFlag, when non-empty, is appended as [ModelFlag, model] when a model is set.
	ModelFlag string
	// CwdFlag, when non-empty, is appended as [CwdFlag, cwd]. Empty → cmd.Dir only.
	CwdFlag string
	// AutoConfirmFlags are appended for headless auto-approve (accept_edits / yolo only).
	AutoConfirmFlags []string
	// AutoConfirmEnv is merged into the process env for the same permission modes.
	AutoConfirmEnv map[string]string
	// NeedsVerification marks known-but-unverified invocations: registered but not Available.
	NeedsVerification bool
}

// GenericInvocations returns the Tier-2 declarative launch table.
// Agents listed here are assembled as genericcli factories by the composition root.
func GenericInvocations() map[string]Invocation {
	return map[string]Invocation{
		"gemini-cli": {
			Mode:             "json",
			Args:             []string{"--prompt", "{{prompt}}", "--output-format", "json"},
			ModelFlag:        "-m",
			AutoConfirmFlags: []string{"--yolo"},
		},
		"qwen-code": {
			Mode:             "json",
			Args:             []string{"-p", "{{prompt}}", "--output-format", "json"},
			ModelFlag:        "-m",
			AutoConfirmFlags: []string{"--yolo"},
		},
		"aider-desk": {
			Mode:             "text",
			Args:             []string{"--message", "{{prompt}}", "--no-show-release-notes"},
			ModelFlag:        "--model",
			AutoConfirmFlags: []string{"--yes-always"},
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
