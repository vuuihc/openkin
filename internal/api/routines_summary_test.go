package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// A summary projection and the response shape are one decision. A legacy array
// must keep carrying the full definitions it always did; an empty `q` or
// `routine_id` is not an explicit page and must not silently blank prompts.
func TestRoutineListSummaryFollowsTheResponseShape(t *testing.T) {
	s, st := newRoutinesTestServer(t)
	const storedPrompt = "read the log and fix what it records"
	if err := st.InsertRoutine(context.Background(), store.Routine{
		ID: "r-1", Cwd: "/tmp", Agent: "kin", Prompt: storedPrompt, IntervalSecs: 3600,
		Enabled: true, Title: "Sweep",
	}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name      string
		query     string
		wantArray bool
		wantRuns  bool
	}{
		{name: "legacy no parameters", wantArray: true},
		{name: "empty q is not a page", query: "?q=", wantArray: true},
		{name: "empty routine_id is not a page", query: "?routine_id=", wantArray: true},
		{name: "a search is a page", query: "?q=sweep"},
		{name: "a routine scope with a feed is a page", query: "?runs=1&routine_id=r-1", wantRuns: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/routines"+tc.query, nil)
			req.Header.Set("Authorization", "Bearer test-token")
			rr := httptest.NewRecorder()
			s.Handler().ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}

			var raw json.RawMessage = rr.Body.Bytes()
			if tc.wantArray {
				var rows []store.Routine
				if err := json.Unmarshal(raw, &rows); err != nil {
					t.Fatalf("legacy array: %v (%s)", err, rr.Body.String())
				}
				if len(rows) != 1 || rows[0].Prompt != storedPrompt {
					t.Fatalf("legacy array lost the stored prompt: %+v", rows)
				}
				return
			}

			var page struct {
				Routines []store.Routine `json:"routines"`
				Runs     []store.Task    `json:"runs"`
			}
			if err := json.Unmarshal(raw, &page); err != nil {
				t.Fatalf("page object: %v (%s)", err, rr.Body.String())
			}
			if len(page.Routines) != 1 || page.Routines[0].Prompt != "" {
				t.Fatalf("a page carried the definition prompt: %+v", page.Routines)
			}
			if tc.wantRuns && page.Runs == nil {
				t.Fatalf("a feed page has no runs array: %s", rr.Body.String())
			}
		})
	}
}
