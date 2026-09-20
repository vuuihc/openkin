package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
