package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/routing"
)

// helper: create a provider profile via the API.
func putProviderProfile(t *testing.T, h http.Handler, token, body string) {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/routing/provider-profiles", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT provider-profiles: %d %s", rr.Code, rr.Body.String())
	}
}

// helper: create a team profile via the API.
func putTeamProfile(t *testing.T, h http.Handler, token, body string) {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/routing/profiles", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT profiles: %d %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Routing defaults roundtrip (US2)
// ---------------------------------------------------------------------------

func TestRoutingDefaultsRoundtrip(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	// Create a provider and team so defaults can reference them.
	putProviderProfile(t, h, token, `{
		"profiles": [{
			"id": "prov-a", "name": "A", "kind": "anthropic-compatible",
			"supports_agents": ["claude-code"], "enabled": true,
			"models": [{"id": "a1", "tier": "smart", "cost_label": "paid"}]
		}]
	}`)
	putTeamProfile(t, h, token, `{
		"profiles": [{
			"id": "t1", "name": "T1", "enabled": true,
			"phases": {
				"execute": {
					"agent": "claude-code", "tier": "smart",
					"provider_priority": ["prov-a"], "fallback": ["next_provider_same_tier"]
				}
			}
		}]
	}`)

	// GET defaults — should return a sensible zero value.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/routing/defaults", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET defaults: %d %s", rr.Code, rr.Body.String())
	}
	var d routing.RoutingDefaults
	if err := json.Unmarshal(rr.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Enabled {
		t.Fatal("expected defaults to start disabled")
	}

	// PUT defaults — enable routing with a valid default_team.
	body := `{"enabled":true,"default_team":"t1","objective":"cost-min","max_attempts_per_step":5,"terminal_limit_policy":"ask","manual_fallback":true}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/routing/defaults", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT defaults: %d %s", rr.Code, rr.Body.String())
	}

	var saved routing.RoutingDefaults
	if err := json.Unmarshal(rr.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if !saved.Enabled {
		t.Fatal("expected enabled=true")
	}
	if saved.Objective != "cost-min" {
		t.Fatalf("objective=%q", saved.Objective)
	}
	if saved.MaxAttemptsPerStep != 5 {
		t.Fatalf("max_attempts=%d", saved.MaxAttemptsPerStep)
	}
	if saved.TerminalLimitPolicy != "ask" {
		t.Fatalf("terminal_limit=%q", saved.TerminalLimitPolicy)
	}
	if !saved.ManualFallback {
		t.Fatal("expected manual_fallback=true")
	}

	// GET again — verify persistence.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/routing/defaults", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET defaults (after put): %d %s", rr.Code, rr.Body.String())
	}
	var reloaded routing.RoutingDefaults
	if err := json.Unmarshal(rr.Body.Bytes(), &reloaded); err != nil {
		t.Fatal(err)
	}
	if reloaded.Objective != "cost-min" || reloaded.MaxAttemptsPerStep != 5 {
		t.Fatalf("reloaded defaults mismatch: %+v", reloaded)
	}
}

func TestRoutingWriteReportsStorageFailureAsServerError(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/routing/defaults",
		bytes.NewBufferString(`{"enabled":false,"objective":"balanced","max_attempts_per_step":3,"terminal_limit_policy":"ask"}`),
	)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRoutingWriteReportsDuplicateProviderAsBadRequest(t *testing.T) {
	s, token := newTestServer(t)
	body := `{"profiles":[
		{"id":"dup","name":"A","kind":"subscription","supports_agents":["claude-code"],"enabled":true,"models":[{"id":"m1","tier":"smart","cost_label":"paid"}]},
		{"id":"dup","name":"B","kind":"subscription","supports_agents":["claude-code"],"enabled":true,"models":[{"id":"m2","tier":"smart","cost_label":"paid"}]}
	]}`
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/routing/provider-profiles",
		bytes.NewBufferString(body),
	)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Routing profiles roundtrip (US1, US7)
// ---------------------------------------------------------------------------

func TestRoutingProfilesRoundtrip(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	// Create a provider so the profile can reference it.
	putProviderProfile(t, h, token, `{
		"profiles": [{
			"id": "prov-a", "name": "A", "kind": "anthropic-compatible",
			"supports_agents": ["claude-code"], "enabled": true,
			"models": [{"id": "a1", "tier": "smart", "cost_label": "paid"}]
		}]
	}`)

	// GET profiles — empty by default.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/routing/profiles", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET profiles: %d %s", rr.Code, rr.Body.String())
	}
	var list routing.TeamProfileList
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Profiles) != 0 {
		t.Fatalf("expected empty profiles, got %d", len(list.Profiles))
	}

	// PUT a valid profile with a valid provider_priority.
	body := `{
		"profiles": [{
			"id": "t1",
			"name": "Team One",
			"enabled": true,
			"phases": {
				"execute": {
					"agent": "claude-code",
					"tier": "smart",
					"provider_priority": ["prov-a"],
					"fallback": ["next_provider_same_tier"]
				}
			}
		}]
	}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/routing/profiles", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT profiles: %d %s", rr.Code, rr.Body.String())
	}

	// GET again — verify persistence.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/routing/profiles", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET profiles (after put): %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(list.Profiles))
	}
	p := list.Profiles[0]
	if p.ID != "t1" || p.Name != "Team One" {
		t.Fatalf("profile mismatch: %+v", p)
	}
	if pp, ok := p.Phases[routing.PhaseExecute]; !ok || pp.Agent != "claude-code" {
		t.Fatalf("phase mismatch: %+v", p.Phases)
	}

	// PUT a profile with an invalid phase agent — should be rejected.
	bodyInvalid := `{
		"profiles": [{
			"id": "t2",
			"name": "Bad Team",
			"enabled": true,
			"phases": {
				"execute": {
					"agent": "nonexistent-agent",
					"tier": "smart",
					"provider_priority": ["prov-a"],
					"fallback": []
				}
			}
		}]
	}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/routing/profiles", bytes.NewReader([]byte(bodyInvalid)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid profile, got %d body=%s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Provider profiles enabled persistence (US1, US7)
// ---------------------------------------------------------------------------

func TestProviderProfilesEnabledPersistence(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	// Create an enabled provider.
	putProviderProfile(t, h, token, `{
		"profiles": [{
			"id": "prov-test", "name": "Test", "kind": "anthropic-compatible",
			"supports_agents": ["claude-code"], "enabled": true,
			"models": [{"id": "m1", "tier": "smart", "cost_label": "paid"}]
		}]
	}`)

	// GET — verify enabled is persisted.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/routing/provider-profiles", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET provider-profiles: %d %s", rr.Code, rr.Body.String())
	}
	var list routing.ProviderProfileList
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range list.Profiles {
		if p.ID == "prov-test" {
			found = true
			if !p.Enabled {
				t.Fatal("expected prov-test to be enabled")
			}
			break
		}
	}
	if !found {
		t.Fatal("prov-test not found in provider profiles")
	}

	// PUT — disable the provider.
	putProviderProfile(t, h, token, `{
		"profiles": [{
			"id": "prov-test", "name": "Test", "kind": "anthropic-compatible",
			"supports_agents": ["claude-code"], "enabled": false,
			"models": [{"id": "m1", "tier": "smart", "cost_label": "paid"}]
		}]
	}`)

	// GET — verify disabled is persisted.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/routing/provider-profiles", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET provider-profiles (after disable): %d %s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	for _, p := range list.Profiles {
		if p.ID == "prov-test" {
			if p.Enabled {
				t.Fatal("expected prov-test to be disabled after PUT")
			}
			return
		}
	}
	t.Fatal("prov-test disappeared after disable PUT")
}

// ---------------------------------------------------------------------------
// Config mutation: disable provider → profile validation rejects it (US7)
// ---------------------------------------------------------------------------

func TestProviderDisableRejectedWhenReferencedByTeam(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	// Create an enabled provider then a team referencing it.
	putProviderProfile(t, h, token, `{
		"profiles": [{
			"id": "prov-d", "name": "D", "kind": "anthropic-compatible",
			"supports_agents": ["claude-code"], "enabled": true,
			"models": [{"id": "d1", "tier": "smart", "cost_label": "paid"}]
		}]
	}`)
	putTeamProfile(t, h, token, `{
		"profiles": [{
			"id": "team-d", "name": "Team D", "enabled": true,
			"phases": {
				"execute": {
					"agent": "claude-code", "tier": "smart",
					"provider_priority": ["prov-d"], "fallback": []
				}
			}
		}]
	}`)

	// Disabling the provider would invalidate the existing team, so reject the write.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/routing/provider-profiles", bytes.NewReader([]byte(`{
		"profiles": [{
			"id": "prov-d", "name": "D", "kind": "anthropic-compatible",
			"supports_agents": ["claude-code"], "enabled": false,
			"models": [{"id": "d1", "tier": "smart", "cost_label": "paid"}]
		}]
	}`)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for provider used by team, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestRoutingOptionsReportsMalformedPersistedDefaults(t *testing.T) {
	s, token := newTestServer(t)
	if err := s.Store.SetSetting(t.Context(), "routing.defaults", `{"enabled":`); err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/routing/options", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if !bytes.Contains(rr.Body.Bytes(), []byte("parse routing.defaults")) {
		t.Fatalf("body=%s", rr.Body.String())
	}
}
