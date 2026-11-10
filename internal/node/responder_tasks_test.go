package node

import (
	"context"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// fakeTaskReader stands in for this machine's own console.
type fakeTaskReader struct {
	taskID    string
	task      RoutineAnswer
	taskErr   error
	eventsID  string
	sinceSeq  int
	events    RoutineAnswer
	eventsErr error
}

func (f *fakeTaskReader) Task(_ context.Context, id string) (RoutineAnswer, error) {
	f.taskID = id
	return f.task, f.taskErr
}

func (f *fakeTaskReader) TaskEvents(_ context.Context, id string, sinceSeq int) (RoutineAnswer, error) {
	f.eventsID = id
	f.sinceSeq = sinceSeq
	return f.events, f.eventsErr
}

// A task that lives on this machine is read here, and the console's own answer
// travels back unchanged. The Hub cannot read this row from its own store: the
// run was created by this machine, and this is where it lives.
func TestTaskQuestionsAreReadOnThisMachine(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	reader := &fakeTaskReader{
		task:   RoutineAnswer{Status: 200, ContentType: "application/json", Body: []byte(`{"id":"t-1","title":"run"}`)},
		events: RoutineAnswer{Status: 200, ContentType: "application/json", Body: []byte(`[{"seq":3}]`)},
	}
	r.Tasks = reader

	result := put(t, r, conn, worker.QueryTaskDetail, worker.TaskDetailParams{ID: "t-1"})
	if result.Error != "" {
		t.Fatalf("the machine refused a task question: %s", result.Error)
	}
	var detail worker.ConsoleResult
	if err := result.Into(&detail); err != nil {
		t.Fatal(err)
	}
	if detail.Status != 200 || string(detail.Body) != `{"id":"t-1","title":"run"}` {
		t.Fatalf("detail = %d %q, want the console's own answer", detail.Status, detail.Body)
	}
	if reader.taskID != "t-1" {
		t.Fatalf("the machine was asked about %q, want t-1", reader.taskID)
	}

	result = put(t, r, conn, worker.QueryTaskEvents, worker.TaskEventsParams{ID: "t-1", SinceSeq: 2})
	if result.Error != "" {
		t.Fatalf("the machine refused a transcript question: %s", result.Error)
	}
	var transcript worker.ConsoleResult
	if err := result.Into(&transcript); err != nil {
		t.Fatal(err)
	}
	if string(transcript.Body) != `[{"seq":3}]` {
		t.Fatalf("transcript = %q, want the console's events", transcript.Body)
	}
	if reader.eventsID != "t-1" || reader.sinceSeq != 2 {
		t.Fatalf("the machine was asked %q since %d, want t-1 since 2", reader.eventsID, reader.sinceSeq)
	}
}

// The id check is enforced by the answering machine too: a machine cannot rely
// on the Hub having checked, and an id that could become another route must
// never reach the console reader.
func TestTaskQuestionsRefuseAnIDThatIsNotOneSegment(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	called := false
	r.Tasks = taskReaderFunc(func(context.Context, string) (RoutineAnswer, error) {
		called = true
		return RoutineAnswer{Status: 200}, nil
	})

	result := put(t, r, conn, worker.QueryTaskDetail, worker.TaskDetailParams{ID: "../events"})
	if result.Error == "" {
		t.Fatal("the machine accepted a task id that leaves its route")
	}
	if !strings.Contains(result.Error, "path segment") {
		t.Fatalf("the refusal does not name the boundary: %s", result.Error)
	}
	if called {
		t.Fatal("the console reader ran with an id the machine should have refused")
	}
}

// A machine with no task store says so. That is the normal answer from a build
// older than the Hub asking, and the Hub reports it as a version skew rather
// than as a bad request.
func TestTaskQuestionsAreRefusedWithoutAReader(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	result := put(t, r, conn, worker.QueryTaskDetail, worker.TaskDetailParams{ID: "t-1"})
	if result.Error == "" {
		t.Fatal("a machine with no task reader answered a task question")
	}
	if !strings.Contains(result.Error, "tasks") {
		t.Fatalf("the refusal does not say what it cannot answer: %s", result.Error)
	}
}

// An answer too large for one frame is refused here, where the sentence can say
// why, rather than by NewFrame after the fact with a message about a frame.
func TestTaskAnswersOverTheFrameAreRefused(t *testing.T) {
	r, conn := responderOn(t, t.TempDir())
	r.Tasks = taskReaderFunc(func(context.Context, string) (RoutineAnswer, error) {
		return RoutineAnswer{Status: 200, Body: make([]byte, worker.MaxTaskResponse+1)}, nil
	})
	result := put(t, r, conn, worker.QueryTaskDetail, worker.TaskDetailParams{ID: "t-1"})
	if result.Error == "" {
		t.Fatal("an oversized transcript answer was sent")
	}
	if !strings.Contains(result.Error, "over the") {
		t.Fatalf("the refusal does not name the size: %s", result.Error)
	}
}

// taskReaderFunc adapts one function to TaskReader, so a test can assert on
// what was called without spelling out both methods.
type taskReaderFunc func(context.Context, string) (RoutineAnswer, error)

func (f taskReaderFunc) Task(ctx context.Context, id string) (RoutineAnswer, error) {
	return f(ctx, id)
}

func (f taskReaderFunc) TaskEvents(ctx context.Context, id string, _ int) (RoutineAnswer, error) {
	return f(ctx, id)
}
