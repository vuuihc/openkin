package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserActionRequiresConfiguredWorker(t *testing.T) {
	s, token := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/tasks/01TESTTASK000000000000000000/browser/actions",
		strings.NewReader(`{"type":"screenshot"}`),
	)
	req.Header.Set("Authorization", "Bearer "+token)
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}
