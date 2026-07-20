package detect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScanMarksInstalled(t *testing.T) {
	dir := t.TempDir()
	// Fake binaries
	for _, name := range []string{"claude", "codex"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	oldPath := os.Getenv("PATH")
	t.Cleanup(func() { _ = os.Setenv("PATH", oldPath) })
	_ = os.Setenv("PATH", dir)
	// Clear env overrides
	for _, k := range []string{"KIN_CLAUDE_BIN", "KIN_CODEX_BIN", "KIN_GROK_BIN"} {
		_ = os.Unsetenv(k)
	}

	oldLook := LookPath
	LookPath = func(file string) (string, error) {
		p := filepath.Join(dir, file)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", os.ErrNotExist
	}
	t.Cleanup(func() { LookPath = oldLook })

	list := Scan("")
	var claude, codex, grok *Info
	for i := range list {
		switch list[i].ID {
		case "claude-code":
			claude = &list[i]
		case "codex":
			codex = &list[i]
		case "grok":
			grok = &list[i]
		}
	}
	if claude == nil || !claude.Installed || !claude.Available {
		t.Fatalf("claude not available: %+v", claude)
	}
	if codex == nil || !codex.Installed {
		t.Fatalf("codex not available: %+v", codex)
	}
	if grok == nil || grok.Installed {
		t.Fatalf("grok should be missing: %+v", grok)
	}
	if !claude.Default {
		t.Fatalf("expected claude-code default, got list=%+v", list)
	}
}

func TestDefaultPrefRespected(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"claude", "codex"} {
		_ = os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0o755)
	}
	oldLook := LookPath
	LookPath = func(file string) (string, error) {
		p := filepath.Join(dir, file)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", os.ErrNotExist
	}
	t.Cleanup(func() { LookPath = oldLook })

	list := Scan("codex")
	for _, i := range list {
		if i.ID == "codex" && !i.Default {
			t.Fatalf("expected codex default")
		}
		if i.ID == "claude-code" && i.Default {
			t.Fatalf("claude should not be default when pref=codex")
		}
	}
}

func TestSkillsCatalogHasCoreAgents(t *testing.T) {
	cat := SkillsDiscoveryCatalog()
	if len(cat) < 20 {
		t.Fatalf("expected broad skills catalog, got %d", len(cat))
	}
	want := map[string]bool{
		"claude-code": false,
		"codex":       false,
		"openclaw":    false,
		"qoder":       false,
		"cursor":      false,
		"grok":        false,
	}
	for _, e := range cat {
		if _, ok := want[e.ID]; ok {
			want[e.ID] = true
		}
	}
	for id, found := range want {
		if !found {
			t.Fatalf("missing %s in skills discovery catalog", id)
		}
	}
	// Runnable subset must include first-class adapters.
	runnable := 0
	for _, e := range cat {
		if e.RunnableHint {
			runnable++
		}
	}
	if runnable < 3 {
		t.Fatalf("runnable hints=%d want >= 3", runnable)
	}
}

func TestScanPresenceConfigDir(t *testing.T) {
	home := t.TempDir()
	// Simulate ~/.openclaw without binary.
	if err := os.MkdirAll(filepath.Join(home, ".openclaw"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldHome := HomeDir
	HomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { HomeDir = oldHome })

	oldLook := LookPath
	LookPath = func(string) (string, error) { return "", os.ErrNotExist }
	t.Cleanup(func() { LookPath = oldLook })

	var openclaw *Presence
	for _, p := range ScanPresence("") {
		if p.ID == "openclaw" {
			cp := p
			openclaw = &cp
			break
		}
	}
	if openclaw == nil {
		t.Fatal("openclaw missing from presence scan")
	}
	if !openclaw.Installed || openclaw.Source != "config" {
		t.Fatalf("openclaw presence: %+v", openclaw)
	}
	if !IsLocallyPresent("openclaw") {
		t.Fatal("IsLocallyPresent(openclaw) = false")
	}
	if IsLocallyPresent("definitely-not-an-agent-xyz") {
		t.Fatal("unexpected presence")
	}
}

func TestCatalogMatchesRunnableHints(t *testing.T) {
	cat := Catalog()
	if len(cat) < 3 {
		t.Fatalf("catalog=%d", len(cat))
	}
	ids := map[string]bool{}
	for _, s := range cat {
		ids[s.ID] = true
	}
	for _, id := range []string{"claude-code", "codex", "grok"} {
		if !ids[id] {
			t.Fatalf("Catalog missing %s", id)
		}
	}
}
