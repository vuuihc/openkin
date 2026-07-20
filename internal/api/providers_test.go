package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
)

func testProviderServer(t *testing.T) (*Server, string, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	token := "test-token"
	auth := remote.NewAuth(token)
	s := &Server{Store: st, Auth: auth, Token: token, NetworkMode: "loopback"}
	return s, token, s.Handler()
}

func TestProvidersCRUDAndActivate(t *testing.T) {
	_, token, h := testProviderServer(t)

	// Empty list
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/providers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list empty: %d %s", rr.Code, rr.Body.String())
	}
	var list providersResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.ActiveID != "" || len(list.Providers) != 0 {
		t.Fatalf("want empty, got %+v", list)
	}

	// Create first
	body := `{"name":"OpenAI","base_url":"https://api.openai.com/v1","api_key":"sk-openai","model":"gpt-4o"}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Providers) != 1 || list.ActiveID == "" {
		t.Fatalf("after create: %+v", list)
	}
	firstID := list.ActiveID
	if list.Providers[0].APIKey == "sk-openai" {
		t.Fatal("api key should be masked")
	}

	// Create second, not active
	body = `{"name":"Ollama","base_url":"http://127.0.0.1:11434/v1","model":"llama3","active":false}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create2: %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.ActiveID != firstID || len(list.Providers) != 2 {
		t.Fatalf("after create2: %+v", list)
	}
	var secondID string
	for _, p := range list.Providers {
		if p.ID != firstID {
			secondID = p.ID
		}
	}

	// Activate second
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/providers/"+secondID+"/activate", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("activate: %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.ActiveID != secondID {
		t.Fatalf("active = %q want %q", list.ActiveID, secondID)
	}

	// Settings mirror active
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("settings: %d %s", rr.Code, rr.Body.String())
	}
	var settings map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["provider.model"] != "llama3" {
		t.Fatalf("settings model = %q", settings["provider.model"])
	}
	if settings["provider.active_id"] != secondID {
		t.Fatalf("settings active = %q", settings["provider.active_id"])
	}

	// Delete active → fallback
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodDelete, "/api/providers/"+secondID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.ActiveID != firstID || len(list.Providers) != 1 {
		t.Fatalf("after delete: %+v", list)
	}
}

func TestLegacySettingsUpsertSyncsRegistry(t *testing.T) {
	_, token, h := testProviderServer(t)

	body := `{"provider.kind":"openai-compatible","provider.base_url":"https://api.openai.com/v1","provider.api_key":"sk-legacy","provider.model":"gpt-4o"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("put settings: %d %s", rr.Code, rr.Body.String())
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/providers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
	var list providersResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Providers) != 1 || list.ActiveID == "" {
		t.Fatalf("registry not synced: %+v", list)
	}
	if list.Providers[0].Model != "gpt-4o" {
		t.Fatalf("model = %q", list.Providers[0].Model)
	}
}


func TestUpdateProviderClearAPIKey(t *testing.T) {
	_, token, h := testProviderServer(t)

	body := `{"name":"P","base_url":"https://api.openai.com/v1","api_key":"sk-secret","model":"m"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	var list providersResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	id := list.ActiveID

	body = `{"name":"P","base_url":"https://api.openai.com/v1","model":"m","clear_api_key":true}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/providers/"+id, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("update: %d %s", rr.Code, rr.Body.String())
	}

	// Reload from store via GET settings — masked empty means no key.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	var settings map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["provider.api_key"] != "" {
		t.Fatalf("want cleared key, got %q", settings["provider.api_key"])
	}
}
