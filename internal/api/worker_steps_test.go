package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// The cancel route's status mapping is the part the engine cannot test: a
// settled step, a task that is not there, and a malformed index are three
// different answers to the caller, and the console tells them apart (409
// refreshes, 404 and 400 are real errors). The 204 path is covered where the
// handle lives, in `TestCancelWorkerStepStopsOnlyThatWorker`.
func TestCancelWorkerStepStatusCodes(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	const taskID = "01WORKERCANCELAPI000000001"
	if err := s.Store.InsertTask(ctx, store.Task{
		ID: taskID, Title: "cancel", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "succeeded", CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		path string
		want int
	}{
		{
			name: "a settled step is a conflict",
			path: "/api/tasks/" + taskID + "/workers/run-1/0/cancel",
			want: http.StatusConflict,
		},
		{
			name: "an unknown task is missing",
			path: "/api/tasks/01NOSUCHTASK000000000001/workers/run-1/0/cancel",
			want: http.StatusNotFound,
		},
		{
			name: "a non-numeric index is a bad request",
			path: "/api/tasks/" + taskID + "/workers/run-1/abc/cancel",
			want: http.StatusBadRequest,
		},
		{
			name: "a negative index is a bad request",
			path: "/api/tasks/" + taskID + "/workers/run-1/-1/cancel",
			want: http.StatusBadRequest,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, tc.path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			h.ServeHTTP(rr, req)
			if rr.Code != tc.want {
				t.Fatalf("status=%d want %d body=%s", rr.Code, tc.want, rr.Body.String())
			}
		})
	}
}
