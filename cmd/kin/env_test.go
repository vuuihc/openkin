package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("# secrets\nA=from-file\nB='quoted value'\nexport C=third\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("A", "from-process")
	if err := loadDotEnv(path); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("A"); got != "from-process" {
		t.Fatalf("A = %q, want process value", got)
	}
	if got := os.Getenv("B"); got != "quoted value" {
		t.Fatalf("B = %q", got)
	}
	if got := os.Getenv("C"); got != "third" {
		t.Fatalf("C = %q", got)
	}
}

func TestLoadDotEnvRejectsInvalidLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("not-an-assignment\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := loadDotEnv(path); err == nil {
		t.Fatal("expected invalid line error")
	}
}
