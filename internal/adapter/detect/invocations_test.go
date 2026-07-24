package detect

import "testing"

func TestGenericInvocationsCoverRequiredAgents(t *testing.T) {
	inv := GenericInvocations()
	required := []string{"gemini-cli", "qwen-code", "aider-desk", "qoder", "opencode", "pi"}
	for _, id := range required {
		got, ok := inv[id]
		if !ok {
			t.Fatalf("missing invocation for %s", id)
		}
		if got.Mode != "json" && got.Mode != "text" {
			t.Fatalf("%s mode=%q", id, got.Mode)
		}
		if len(got.Args) == 0 {
			t.Fatalf("%s has empty Args", id)
		}
		hasPrompt := false
		for _, a := range got.Args {
			if a == "{{prompt}}" {
				hasPrompt = true
				break
			}
		}
		if !hasPrompt {
			t.Fatalf("%s Args missing {{prompt}}: %v", id, got.Args)
		}
	}
}

func TestGenericInvocationsNeedsVerification(t *testing.T) {
	inv := GenericInvocations()
	for _, id := range []string{"qoder", "opencode", "pi"} {
		if !inv[id].NeedsVerification {
			t.Fatalf("%s should NeedsVerification", id)
		}
	}
	for _, id := range []string{"gemini-cli", "qwen-code", "aider-desk"} {
		if inv[id].NeedsVerification {
			t.Fatalf("%s should not NeedsVerification", id)
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
