package detect

import "testing"

func TestGenericInvocationsRequiredIDs(t *testing.T) {
	inv := GenericInvocations()
	required := []string{"gemini-cli", "qwen-code", "aider-desk", "qoder", "opencode", "pi"}
	for _, id := range required {
		if _, ok := inv[id]; !ok {
			t.Fatalf("missing invocation %q", id)
		}
	}
}

func TestGenericInvocationsModes(t *testing.T) {
	for id, inv := range GenericInvocations() {
		if inv.Mode != "json" && inv.Mode != "text" {
			t.Fatalf("%s: bad mode %q", id, inv.Mode)
		}
		if len(inv.Args) == 0 {
			t.Fatalf("%s: empty Args", id)
		}
		hasPrompt := false
		for _, a := range inv.Args {
			if a == "{{prompt}}" {
				hasPrompt = true
				break
			}
		}
		if !hasPrompt {
			t.Fatalf("%s: Args must include {{prompt}}", id)
		}
	}
}

func TestGenericInvocationsNeedsVerification(t *testing.T) {
	// Default policy: every Tier-2 launch line stays unavailable until smoke-tested.
	for id, inv := range GenericInvocations() {
		if !inv.NeedsVerification {
			t.Fatalf("%s should NeedsVerification by default", id)
		}
	}
}

func TestIsGenericCLI(t *testing.T) {
	if !IsGenericCLI("gemini-cli") {
		t.Fatal("gemini-cli should be generic")
	}
	if IsGenericCLI("claude-code") {
		t.Fatal("claude-code is native, not generic")
	}
	if IsGenericCLI("") {
		t.Fatal("empty should not be generic")
	}
}

func TestGenericInvocationsIDsExistInDiscoveryCatalog(t *testing.T) {
	catalog := map[string]bool{}
	for _, sp := range SkillsDiscoveryCatalog() {
		catalog[sp.ID] = true
	}
	for id := range GenericInvocations() {
		if !catalog[id] {
			t.Fatalf("invocation id %q missing from SkillsDiscoveryCatalog", id)
		}
	}
}
