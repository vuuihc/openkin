package secret

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileStoreRoundTripAndPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "credentials")
	s, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := NewReference()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ref, "secret-value"); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ref)
	if err != nil || got != "secret-value" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	info, err := os.Stat(filepath.Join(dir, ref))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
}
