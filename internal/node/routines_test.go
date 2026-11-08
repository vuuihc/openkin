package node

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// The loopback caller is where the two halves of the routine relay meet: the
// Hub's request becomes this console's request, with this process's own
// credentials, and the console's answer comes back as it stands.
func TestLocalRoutineCallerSpeaksToThisConsolesAPI(t *testing.T) {
	type seen struct{ method, path, auth, contentType, body string }
	var got seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = seen{
			method:      r.Method,
			path:        r.URL.RequestURI(),
			auth:        r.Header.Get("Authorization"),
			contentType: r.Header.Get("Content-Type"),
			body:        string(body),
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"r-1"}`))
	}))
	defer srv.Close()

	call := LocalRoutineCaller(srv.URL+"/", func() string { return "master-token" })
	answer, err := call(context.Background(), worker.RoutinesParams{
		Method: "POST",
		Path:   "/api/routines?page=1",
		Body:   []byte(`{"title":"t"}`),
	})
	if err != nil {
		t.Fatalf("the caller did not reach the console: %v", err)
	}
	if got.method != http.MethodPost || got.path != "/api/routines?page=1" {
		t.Fatalf("the console was asked %s %s", got.method, got.path)
	}
	if got.auth != "Bearer master-token" {
		t.Fatalf("authorization = %q, want this process's own token", got.auth)
	}
	if got.contentType != "application/json" {
		t.Fatalf("content type = %q", got.contentType)
	}
	if got.body != `{"title":"t"}` {
		t.Fatalf("body = %q", got.body)
	}
	if answer.Status != http.StatusCreated {
		t.Fatalf("status = %d, want the console's own", answer.Status)
	}
	if answer.ContentType != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", answer.ContentType)
	}
	if string(answer.Body) != `{"id":"r-1"}` {
		t.Fatalf("body = %q, want the console's answer unchanged", answer.Body)
	}
}

// An answer that cannot fit one worker frame is refused where the sentence can
// say why, rather than on the wire where the only visible symptom is a timeout.
func TestLocalRoutineCallerRefusesAnAnswerOverTheFrame(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, worker.MaxRoutineResponse+1))
	}))
	defer srv.Close()

	call := LocalRoutineCaller(srv.URL, func() string { return "t" })
	if _, err := call(context.Background(), worker.RoutinesParams{Method: "GET", Path: "/api/routines"}); err == nil {
		t.Fatal("an oversized answer was passed back")
	} else if !strings.Contains(err.Error(), "over the") {
		t.Fatalf("the refusal does not name the size: %v", err)
	}
}

// The caller holds the same boundary as the answering side: a request outside
// the routine subtree never reaches the console at all.
func TestLocalRoutineCallerRefusesAPathOutsideTheSubtree(t *testing.T) {
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
	}))
	defer srv.Close()

	call := LocalRoutineCaller(srv.URL, func() string { return "t" })
	if _, err := call(context.Background(), worker.RoutinesParams{Method: "GET", Path: "/api/tasks"}); err == nil {
		t.Fatal("the caller sent a request outside /api/routines")
	}
	if called.Load() {
		t.Fatal("the console was reached by a request the caller should have refused")
	}
}
