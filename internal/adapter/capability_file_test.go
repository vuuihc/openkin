package adapter

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAndReadCapabilityFile(t *testing.T) {
	dir := t.TempDir()
	token := "test-token-value"

	path, err := WriteCapabilityFile(dir, token)
	if err != nil {
		t.Fatalf("write capability file: %v", err)
	}

	if path == "" {
		t.Fatal("empty path returned")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(data) != token {
		t.Fatalf("got %q want %q", string(data), token)
	}
}

func TestWriteCapabilityFile_RejectsEmptyDir(t *testing.T) {
	_, err := WriteCapabilityFile("", "token")
	if err == nil {
		t.Fatal("expected error for empty dir")
	}
}

func TestWriteCapabilityFile_RejectsEmptyToken(t *testing.T) {
	_, err := WriteCapabilityFile(t.TempDir(), "")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestRemoveCapabilityFile(t *testing.T) {
	dir := t.TempDir()
	path, err := WriteCapabilityFile(dir, "tok")
	if err != nil {
		t.Fatal(err)
	}

	RemoveCapabilityFile(path)

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("file should be removed")
	}
}

func TestRemoveCapabilityFile_NoErrorForMissing(t *testing.T) {
	// Should not panic or error
	RemoveCapabilityFile(filepath.Join(t.TempDir(), "nonexistent"))
}

func TestCapabilityFileEnv(t *testing.T) {
	env := CapabilityFileEnv("/path/to/token")
	if env == nil {
		t.Fatal("expected non-nil env")
	}
	if env[EnvKinExecutionToken] != "/path/to/token" {
		t.Fatalf("got %q", env[EnvKinExecutionToken])
	}

	env = CapabilityFileEnv("")
	if env != nil {
		t.Fatal("expected nil env for empty path")
	}
}
