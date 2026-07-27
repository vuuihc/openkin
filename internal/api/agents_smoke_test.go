package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

func TestHandleAgentsSmokeNotConfigured(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/agents/smoke", nil)
	rr := httptest.NewRecorder()
	s.handleAgentsSmoke(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestHandleAgentsSmokeOK(t *testing.T) {
	s := &Server{
		SmokeAgents: func(ctx context.Context, ids []string) []AgentSmokeResult {
			return []AgentSmokeResult{{ID: "pi", OK: true, Installed: true, Available: true, Detail: "exit 0"}}
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/agents/smoke", nil)
	rr := httptest.NewRecorder()
	s.handleAgentsSmoke(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Results []AgentSmokeResult `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Results) != 1 || body.Results[0].ID != "pi" || !body.Results[0].OK {
		t.Fatalf("%+v", body.Results)
	}
}

func TestRunGenericCLISmokeSkipsMissing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("path look")
	}
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	results := RunGenericCLISmoke(context.Background(), st, []string{"this-is-not-an-agent"})
	if len(results) != 1 || !results[0].Skipped {
		t.Fatalf("%+v", results)
	}
}
