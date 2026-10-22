package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// The stream has to be a stream: the first bytes must reach the client while the
// handler is still running, or a proxy or a buffering layer has turned realtime
// into "after the fact".
func TestEventStreamDeliversFramesWhileConnected(t *testing.T) {
	s, token := newTestServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content type = %q", ct)
	}

	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read preamble: %v", err)
	}
	if !strings.HasPrefix(line, "retry:") {
		t.Fatalf("first line = %q, want a retry hint", line)
	}

	// A published change must arrive on the open stream.
	s.Engine.Bus().PublishTask(store.Task{ID: "task-live", Title: "live", Status: "running"})

	deadline := time.Now().Add(5 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("no frame arrived on the stream")
		}
		line, err = reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		if strings.HasPrefix(line, ": ") {
			continue // heartbeat
		}
		if !strings.HasPrefix(line, "event: ") {
			continue
		}
		kind := strings.TrimSpace(strings.TrimPrefix(line, "event: "))
		data, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read data line: %v", err)
		}
		if !strings.HasPrefix(data, "data: ") {
			t.Fatalf("data line = %q", data)
		}
		var msg task.WSMessage
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(data, "data: "))), &msg); err != nil {
			t.Fatalf("decode frame %q: %v", data, err)
		}
		if kind != "task_update" || msg.Kind != "task_update" {
			t.Fatalf("frame kind = %q/%q", kind, msg.Kind)
		}
		return
	}
}

func TestEventStreamRequiresAuthentication(t *testing.T) {
	s, _ := newTestServer(t)
	rr := httptest.NewRecorder()
	s.Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/events", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

// The long poll exists for clients that cannot hold a stream open. It answers
// the moment there is something to say, and otherwise says nothing on a timer
// rather than hanging.
func TestSessionsWaitReturnsImmediatelyWhenThereAreChanges(t *testing.T) {
	s, token := newTestServer(t)
	insertSessionTestTask(t, s, "task-a")

	start := time.Now()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/wait?timeout=30", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("waited %s with a change pending", elapsed)
	}
	var page store.TaskChangePage
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Tasks) != 1 || page.Tasks[0].ID != "task-a" {
		t.Fatalf("page = %+v", page)
	}
}

// Idle: the poll returns an empty page at the timeout, with the client's cursor
// unchanged, so a polling client can tell "nothing happened" from "I lost my
// place".
func TestSessionsWaitTimesOutWithNoChanges(t *testing.T) {
	s, token := newTestServer(t)
	insertSessionTestTask(t, s, "task-a")
	_, first := getSessions(t, s, token, "")

	start := time.Now()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/sessions/wait?updated_since=%d&timeout=1", first.NextCursor), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	s.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond {
		t.Fatalf("returned after %s, want to wait out the timeout", elapsed)
	}
	var page store.TaskChangePage
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Tasks) != 0 || page.HasMore || page.NextCursor != first.NextCursor {
		t.Fatalf("idle page = %+v", page)
	}
}

// A change while the client is parked wakes it up, rather than making it wait
// out the whole timeout and feel broken.
func TestSessionsWaitWakesOnABusMessage(t *testing.T) {
	s, token := newTestServer(t)
	insertSessionTestTask(t, s, "task-a")
	_, first := getSessions(t, s, token, "")

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet,
			fmt.Sprintf("/api/sessions/wait?updated_since=%d&timeout=30", first.NextCursor), nil)
		req.Header.Set("Authorization", "Bearer "+token)
		s.Handler().ServeHTTP(rr, req)
		done <- rr
	}()

	// Give the handler time to park before nudging it.
	time.Sleep(200 * time.Millisecond)
	s.Engine.Bus().PublishTask(store.Task{ID: "task-a", Title: "changed", Status: "running"})

	select {
	case rr := <-done:
		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d body %s", rr.Code, rr.Body.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("long poll did not wake on a bus message")
	}
}

func TestSessionsWaitRejectsBadInput(t *testing.T) {
	s, token := newTestServer(t)
	for _, query := range []string{"?updated_since=-1", "?updated_since=x", "?timeout=-1", "?timeout=soon"} {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/sessions/wait"+query, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		s.Handler().ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d, want 400", query, rr.Code)
		}
	}
}
