package server

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func TestEnsureDesktopIdentityPersistsStableIDAndName(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	first, err := ensureDesktopIdentity(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.Name == "" {
		t.Fatalf("identity incomplete: %+v", first)
	}

	second, err := ensureDesktopIdentity(context.Background(), st)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("identity was not stable: first=%+v second=%+v", first, second)
	}
}
