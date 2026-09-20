package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

type memorySecretStore struct {
	values map[string]string
}

func (s *memorySecretStore) Get(ref string) (string, error) {
	v, ok := s.values[ref]
	if !ok {
		return "", store.ErrNotFound
	}
	return v, nil
}

func (s *memorySecretStore) Put(ref, value string) error {
	if s.values == nil {
		s.values = map[string]string{}
	}
	s.values[ref] = value
	return nil
}

func (s *memorySecretStore) Delete(ref string) error {
	delete(s.values, ref)
	return nil
}

func TestBeginAuthIncludesCloudflareScopes(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := &Service{
		Store:       st,
		Secrets:     &memorySecretStore{},
		AuthURL:     "https://dash.cloudflare.test/oauth2/auth",
		RedirectURI: "http://127.0.0.1:9999/api/cloudflare/oauth/callback",
	}

	rawURL, err := svc.BeginAuth(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	auth, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	scope := strings.Fields(auth.Query().Get("scope"))
	wantScope := map[string]bool{
		"workers-scripts.read":  false,
		"workers-scripts.write": false,
		"account-settings.read": false,
		"zone.read":             false,
	}
	if len(scope) != len(wantScope) {
		t.Fatalf("scope count=%d, want %d: %q", len(scope), len(wantScope), auth.Query().Get("scope"))
	}
	for _, item := range scope {
		if _, ok := wantScope[item]; ok {
			wantScope[item] = true
		}
	}
	for item, found := range wantScope {
		if !found {
			t.Fatalf("scope %q missing from %q", item, auth.Query().Get("scope"))
		}
	}
	if auth.Query().Get("code_challenge") == "" {
		t.Fatalf("missing code_challenge in %s", rawURL)
	}
}

func TestCompleteAuthUsesStoredVerifierWhenSecretStoreValueIsShort(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	secrets := &memorySecretStore{}
	var gotVerifier string
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth2/token" {
			t.Fatalf("unexpected request %s", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotVerifier = r.Form.Get("code_verifier")
		writeTestJSON(w, http.StatusOK, map[string]any{
			"access_token":  "access-1",
			"refresh_token": "refresh-1",
			"expires_in":    3600,
		})
	}))
	defer cf.Close()
	svc := &Service{
		Store:       st,
		Secrets:     secrets,
		Client:      cf.Client(),
		AuthURL:     cf.URL + "/oauth2/auth",
		TokenURL:    cf.URL + "/oauth2/token",
		RedirectURI: "http://127.0.0.1:9999/api/cloudflare/oauth/callback",
	}

	rawURL, err := svc.BeginAuth(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	auth, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	wantVerifier, _ := st.GetSetting(context.Background(), keyOAuthVerifier)
	if len(wantVerifier) < 43 {
		t.Fatalf("stored verifier too short: %d", len(wantVerifier))
	}
	if err := secrets.Put(refOAuthVerifier, "short"); err != nil {
		t.Fatal(err)
	}

	if err := svc.CompleteAuth(context.Background(), auth.Query().Get("state"), "code-1"); err != nil {
		t.Fatal(err)
	}
	if gotVerifier != wantVerifier {
		t.Fatalf("code_verifier=%q, want stored verifier", gotVerifier)
	}
	if got, _ := st.GetSetting(context.Background(), keyOAuthVerifier); got != "" {
		t.Fatalf("verifier was not cleared: %q", got)
	}
}

func TestDeployRelayRejectsCloudflareSuccessFalseEnvelope(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	secrets := &memorySecretStore{}
	token, err := json.Marshal(tokenSet{
		AccessToken: "access-1",
		ExpiresAt:   time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := secrets.Put(refOAuthToken, string(token)); err != nil {
		t.Fatal(err)
	}
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/client/v4/accounts":
			writeTestJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result":  []map[string]string{{"id": "acc1", "name": "Primary"}},
			})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/scripts/kin-relay" && r.Method == http.MethodPut:
			writeTestJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"errors":  []map[string]string{{"message": "script upload denied"}},
			})
		default:
			t.Fatalf("unexpected Cloudflare request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer cf.Close()
	svc := &Service{
		Store:   st,
		Secrets: secrets,
		Client:  cf.Client(),
		APIBase: cf.URL + "/client/v4",
	}

	_, err = svc.DeployRelay(context.Background(), DeployRequest{AccountID: "acc1", ScriptName: "kin-relay"})
	if err == nil || !strings.Contains(err.Error(), "script upload denied") {
		t.Fatalf("DeployRelay error=%v", err)
	}
	if got, _ := st.GetSetting(context.Background(), keyWorkerURL); got != "" {
		t.Fatalf("worker URL persisted after failed upload: %q", got)
	}
}

func writeTestJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
