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
