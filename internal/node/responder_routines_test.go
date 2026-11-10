package node

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// A relayed routine request is run by this machine, and its answer is the
// console's own: status, content type, and body travel back unchanged. The
// machine does not translate the request into a routine of its own, because
// there is nothing to translate — it is the same request its local console
// would have sent.
func TestRoutineQuestionsRunOnThisMachine(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	var got worker.RoutinesParams
	r.Routines = func(_ context.Context, asked worker.RoutinesParams) (RoutineAnswer, error) {
		got = asked
		return RoutineAnswer{
			Status:      201,
			ContentType: "application/json",
			Body:        []byte(`{"id":"r-1","title":"relayed"}`),
		}, nil
	}

	result := put(t, r, conn, worker.QueryRoutines, worker.RoutinesParams{
		Method: "POST",
		Path:   "/api/routines?page=1",
		Body:   []byte(`{"title":"relayed"}`),
	})
	if result.Error != "" {
		t.Fatalf("the machine refused a routine request: %s", result.Error)
	}
	var answer worker.ConsoleResult
	if err := result.Into(&answer); err != nil {
		t.Fatal(err)
	}
	if answer.Status != 201 {
		t.Fatalf("status = %d, want the console's own 201", answer.Status)
	}
	if answer.ContentType != "application/json" {
		t.Fatalf("content type = %q", answer.ContentType)
	}
	if string(answer.Body) != `{"id":"r-1","title":"relayed"}` {
		t.Fatalf("body = %q, want the console's answer unchanged", answer.Body)
	}
	if got.Method != "POST" || got.Path != "/api/routines?page=1" {
		t.Fatalf("the machine was asked %s %s", got.Method, got.Path)
	}
	if string(got.Body) != `{"title":"relayed"}` {
		t.Fatalf("body reached the machine as %q", got.Body)
	}
}

// The relay's path check is enforced by the answering machine too, not only by
// the Hub: a machine cannot rely on the Hub having checked, and a request
// outside the routine subtree must never reach the console caller.
func TestRoutineQuestionsRefuseAPathOutsideTheSubtree(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	var called atomic.Bool
	r.Routines = func(_ context.Context, asked worker.RoutinesParams) (RoutineAnswer, error) {
		called.Store(true)
		return RoutineAnswer{Status: 200}, nil
	}

	result := put(t, r, conn, worker.QueryRoutines, worker.RoutinesParams{
		Method: "GET", Path: "/api/tasks",
	})
	if result.Error == "" {
		t.Fatal("the machine accepted a routine request outside /api/routines")
	}
	if !strings.Contains(result.Error, "/api/routines") {
		t.Fatalf("the refusal does not name the boundary: %s", result.Error)
	}
	if called.Load() {
		t.Fatal("the console caller ran a request the machine should have refused")
	}
}

// A machine with no routines caller says so. That is the normal answer from a
// build older than the Hub asking, and the Hub reports it as such rather than as
// a bad request.
func TestRoutineQuestionsAreRefusedWithoutACaller(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	result := put(t, r, conn, worker.QueryRoutines, worker.RoutinesParams{
		Method: "GET", Path: "/api/routines",
	})
	if result.Error == "" {
		t.Fatal("a machine with no routine caller answered a routine question")
	}
	if !strings.Contains(result.Error, "routine") {
		t.Fatalf("the refusal does not say what it cannot answer: %s", result.Error)
	}
}

// An answer too large for one frame is refused here, where the sentence can say
// why, rather than by NewFrame after the fact with a message about a frame.
func TestRoutineAnswersOverTheFrameAreRefused(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	r.Routines = func(_ context.Context, asked worker.RoutinesParams) (RoutineAnswer, error) {
		return RoutineAnswer{Status: 200, Body: make([]byte, worker.MaxRoutineResponse+1)}, nil
	}
	result := put(t, r, conn, worker.QueryRoutines, worker.RoutinesParams{
		Method: "GET", Path: "/api/routines",
	})
	if result.Error == "" {
		t.Fatal("an oversized routine answer was sent")
	}
	if !strings.Contains(result.Error, "over the") {
		t.Fatalf("the refusal does not name the size: %s", result.Error)
	}
}
