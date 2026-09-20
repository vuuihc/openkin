package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
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
	var settings map[string]any
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

func TestActivateProviderRejectsNonRuntimeProvider(t *testing.T) {
	s, token, h := testProviderServer(t)
	create := `{
		"id":"runtime","name":"Runtime","kind":"openai-compatible",
		"base_url":"https://runtime.example/v1","model":"runtime-model"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewBufferString(create))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	putProviderProfile(t, h, token, `{"profiles":[{
		"id":"routing-only","name":"Routing Only","kind":"subscription",
		"supports_agents":["droid"],"enabled":true,
		"models":[{"id":"route-model","tier":"smart","cost_label":"company"}]
	}]}`)

	req = httptest.NewRequest(http.MethodPost, "/api/providers/routing-only/activate", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("activate status=%d body=%s", rec.Code, rec.Body.String())
	}

	reg, err := provider.LoadRegistry(context.Background(), s.Store)
	if err != nil {
		t.Fatal(err)
	}
	if reg.ActiveID != "runtime" {
		t.Fatalf("active provider changed after rejected activation: %q", reg.ActiveID)
	}
	for key, want := range map[string]string{
		provider.KeyActiveProvider: "runtime",
		provider.KeyBaseURL:        "https://runtime.example/v1",
		provider.KeyModel:          "runtime-model",
	} {
		got, getErr := s.Store.GetSetting(context.Background(), key)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if got != want {
			t.Fatalf("%s changed after rejected activation: got %q want %q", key, got, want)
		}
	}
}

func TestProviderCRUDPreservesRoutingMetadataAndRejectsReferencedDelete(t *testing.T) {
	s, token, h := testProviderServer(t)
	create := `{"id":"shared","name":"Shared","kind":"openai-compatible","base_url":"https://example.com/v1","api_key":"secret","model":"m1","stream":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewBufferString(create))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	putProviderProfile(t, h, token, `{"profiles":[{
		"id":"shared","name":"Shared","kind":"openai-compatible",
		"supports_agents":["kin"],"enabled":true,
		"models":[{"id":"m1","tier":"smart","cost_label":"paid"}]
	}]}`)
	configured, err := provider.LoadRegistry(context.Background(), s.Store)
	if err != nil {
		t.Fatal(err)
	}
	if entry, ok := configured.ByID("shared"); !ok || len(entry.SupportsAgents) != 1 {
		t.Fatalf("provider routing metadata not persisted: %+v", entry)
	}
	putTeamProfile(t, h, token, `{"profiles":[{
		"id":"team","name":"Team","enabled":true,
		"phases":{"execute":{"agent":"kin","tier":"smart","provider_priority":["shared"],"fallback":[]}}
	}]}`)

	update := `{"name":"Renamed","kind":"openai-compatible","base_url":"https://new.example/v1","model":"m1"}`
	req = httptest.NewRequest(http.MethodPut, "/api/providers/shared", bytes.NewBufferString(update))
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", rec.Code, rec.Body.String())
	}
	registry, err := provider.LoadRegistry(context.Background(), s.Store)
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := registry.ByID("shared")
	if !ok || len(entry.SupportsAgents) != 1 || len(entry.Models) != 1 || entry.Enabled == nil || !*entry.Enabled || !entry.Stream {
		t.Fatalf("routing metadata lost: %+v", entry)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/providers/shared", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLegacyProviderSettingsRejectAtomicallyWhenProviderIsReferenced(t *testing.T) {
	s, token, h := testProviderServer(t)
	create := `{"id":"shared","name":"Shared","kind":"openai-compatible","base_url":"https://example.com/v1","api_key":"secret","model":"m1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewBufferString(create))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	putProviderProfile(t, h, token, `{"profiles":[{
		"id":"shared","name":"Shared","kind":"openai-compatible",
		"supports_agents":["kin"],"enabled":true,
		"models":[{"id":"m1","tier":"smart","cost_label":"paid"}]
	}]}`)
	putTeamProfile(t, h, token, `{"profiles":[{
		"id":"team","name":"Team","enabled":true,
		"phases":{"execute":{"agent":"kin","tier":"smart","provider_priority":["shared"],"fallback":[]}}
	}]}`)

	req = httptest.NewRequest(
		http.MethodPut,
		"/api/settings",
		bytes.NewBufferString(`{"provider.base_url":"","provider.model":"","notify.ntfy_topic":"must-not-persist"}`),
	)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("settings status=%d body=%s", rec.Code, rec.Body.String())
	}
	registry, err := provider.LoadRegistry(context.Background(), s.Store)
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := registry.ByID("shared")
	if !ok || entry.BaseURL != "https://example.com/v1" || entry.Model != "m1" {
		t.Fatalf("provider changed after rejected settings update: %+v", entry)
	}
	if _, err := s.Store.GetSetting(context.Background(), "notify.ntfy_topic"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unrelated setting persisted after rejected request: %v", err)
	}
}

func TestProviderMutationRejectsBlankID(t *testing.T) {
	_, token, h := testProviderServer(t)
	for _, method := range []string{http.MethodDelete, http.MethodPost} {
		path := "/api/providers/%20"
		if method == http.MethodPost {
			path += "/activate"
		}
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d body=%s", method, rec.Code, rec.Body.String())
		}
	}
}

func TestGetSettingsReportsMalformedProviderRegistry(t *testing.T) {
	s, token, h := testProviderServer(t)
	if err := s.Store.SetSetting(t.Context(), "providers", `{"entries":`); err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if !bytes.Contains(rr.Body.Bytes(), []byte("parse providers")) {
		t.Fatalf("body=%s", rr.Body.String())
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
	var settings map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["provider.api_key"] != "" {
		t.Fatalf("want cleared key, got %q", settings["provider.api_key"])
	}
}

func TestListProviderModels(t *testing.T) {
	_, token, h := testProviderServer(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-real" {
			t.Fatalf("auth = %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"id": "model-a"}, {"id": "model-b"}},
		})
	}))
	defer upstream.Close()

	// Create a provider with a real key, so we can exercise masked-key resolution.
	createBody := fmt.Sprintf(`{"name":"P","base_url":%q,"api_key":"sk-real","model":"model-a"}`, upstream.URL+"/v1")
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewReader([]byte(createBody)))
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
	maskedKey := list.Providers[0].APIKey

	// Fetch models by id, echoing back the masked key (as the UI would).
	body := fmt.Sprintf(`{"id":%q,"base_url":%q,"api_key":%q}`, id, upstream.URL+"/v1", maskedKey)
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/providers/models", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("models: %d %s", rr.Code, rr.Body.String())
	}
	var res providerModelsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Models) != 2 || res.Models[0] != "model-a" || res.Models[1] != "model-b" {
		t.Fatalf("models = %v", res.Models)
	}

	// Unsaved form (no id, explicit key) also works.
	body = fmt.Sprintf(`{"base_url":%q,"api_key":"sk-real"}`, upstream.URL+"/v1")
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/providers/models", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("models (no id): %d %s", rr.Code, rr.Body.String())
	}
}

func TestProviderStreamFlag(t *testing.T) {
	_, token, h := testProviderServer(t)

	body := `{"name":"S","base_url":"https://api.openai.com/v1","api_key":"sk","model":"m","stream":true}`
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
	if len(list.Providers) != 1 || !list.Providers[0].Stream {
		t.Fatalf("want stream true, got %+v", list.Providers)
	}
	id := list.Providers[0].ID

	// Omit stream on update → keep true
	body = `{"name":"S","base_url":"https://api.openai.com/v1","model":"m2"}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/providers/"+id, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("update: %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if !list.Providers[0].Stream || list.Providers[0].Model != "m2" {
		t.Fatalf("preserve stream: %+v", list.Providers[0])
	}

	// Explicit false
	body = `{"name":"S","base_url":"https://api.openai.com/v1","model":"m2","stream":false}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/providers/"+id, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Providers[0].Stream {
		t.Fatalf("want stream false, got %+v", list.Providers[0])
	}

	// Settings mirror
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	var settings map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["provider.stream"] != "false" {
		t.Fatalf("settings stream=%q", settings["provider.stream"])
	}
}
