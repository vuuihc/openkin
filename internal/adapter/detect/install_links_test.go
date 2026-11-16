package detect

import "testing"

func TestInstallURLTier2(t *testing.T) {
	for _, id := range []string{"gemini-cli", "qwen-code", "aider-desk", "qoder", "opencode", "pi"} {
		if InstallURL(id) == "" {
			t.Fatalf("InstallURL(%s) empty", id)
		}
	}
}

func TestInstallURLNativeAndPresence(t *testing.T) {
	for _, id := range []string{"claude-code", "codex", "grok", "cursor", "windsurf", "zed"} {
		if InstallURL(id) == "" {
			t.Fatalf("InstallURL(%s) empty", id)
		}
	}
}

func TestInstallURLUnknown(t *testing.T) {
	if got := InstallURL("definitely-not-an-agent"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := InstallURL(""); got != "" {
		t.Fatalf("empty id got %q", got)
	}
}

func TestInstallURLNoDeadKeys(t *testing.T) {
	valid := map[string]bool{}
	for _, sp := range SkillsDiscoveryCatalog() {
		valid[sp.ID] = true
	}
	for id := range installURLs {
		if !valid[id] {
			t.Errorf("installURLs key %q matches no catalog id", id)
		}
	}
}

func TestInstallURLCoverageOfCatalog(t *testing.T) {
	// Soft coverage: majority of catalog should have links; flag total misses.
	missing := 0
	for _, sp := range SkillsDiscoveryCatalog() {
		if InstallURL(sp.ID) == "" {
			missing++
		}
	}
	// Allow some obscure entries without known URLs.
	if missing > 25 {
		t.Fatalf("too many catalog entries without InstallURL: %d", missing)
	}
}
