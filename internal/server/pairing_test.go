package server

import (
	"context"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func TestIssuePairingURLIncludesDesktopIdentity(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	got, err := issuePairingURL(
		context.Background(),
		st,
		"https://relay.example.test/?room=room-1&key=relay-key&token=old",
		"relay",
		desktopIdentity{ID: "desktop_1234abcd", Name: "Work Mac"},
	)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	if query.Get("desktop_id") != "desktop_1234abcd" || query.Get("desktop_name") != "Work Mac" {
		t.Fatalf("desktop identity missing from pairing URL: %s", got)
	}
	if query.Get("pairing") != "1" || query.Get("token") == "" || query.Get("token") == "old" {
		t.Fatalf("pairing token not refreshed: %s", got)
	}
}
