package node

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Two reasons a test needs to state rather than provoke.
var (
	errOutsideRoots = errors.New("/etc is not a directory this machine works in")
	errWriteFailed  = errors.New("the socket is gone")
)

type askOutcome struct {
	result worker.QueryResult
	err    error
}

// askInBackground runs Ask on its own goroutine: everything these tests are
// about happens while the question is still open.
func askInBackground(ctx context.Context, q *Queries, sender Sender, method string, params any) <-chan askOutcome {
	out := make(chan askOutcome, 1)
	go func() {
		result, err := q.Ask(ctx, sender, method, params)
		out <- askOutcome{result: result, err: err}
	}()
	return out
}

// questionsSent reads the questions that have reached a machine so far.
func questionsSent(t *testing.T, conn *testConn) []worker.Query {
	t.Helper()
	var out []worker.Query
	for _, frame := range conn.sent() {
		if frame.Kind != "query" {
			continue
		}
		question, err := Decode[worker.Query](frame)
		if err != nil {
			t.Fatalf("the hub sent a question this machine cannot read: %v", err)
		}
		out = append(out, question)
	}
	return out
}

// awaitQuestions waits until n questions have reached the machine.
func awaitQuestions(t *testing.T, conn *testConn, n int) []worker.Query {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := questionsSent(t, conn); len(got) >= n {
			return got
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("only %d of %d questions reached the machine", len(questionsSent(t, conn)), n)
	return nil
}

// answer feeds a Node's answer back the way the connection's read loop does.
func answer(t *testing.T, q *Queries, conn *testConn, result worker.QueryResult) error {
	t.Helper()
	frame, err := worker.NewFrame("query.result", result)
	if err != nil {
		t.Fatal(err)
	}
	return q.Route(context.Background(), conn, frame)
}

func TestAskPairsTheAnswerWithTheQuestion(t *testing.T) {
	q := NewQueries()
	conn := newTestConn("device-ask")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	waiting := askInBackground(ctx, q, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/code"})
	sent := awaitQuestions(t, conn, 1)
	if sent[0].Method != worker.QueryListDirs {
		t.Fatalf("the machine was asked %q, want %q", sent[0].Method, worker.QueryListDirs)
	}
	var params worker.ListDirsParams
	if err := json.Unmarshal(sent[0].Params, &params); err != nil {
		t.Fatalf("the question carried no readable params: %v", err)
	}
	if params.Path != "/code" {
		t.Fatalf("params = %+v, want the path the caller named", params)
	}

	result, err := worker.Answer(sent[0].ID, worker.ListDirsResult{Path: "/code", Entries: []string{"kin"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := answer(t, q, conn, result); err != nil {
		t.Fatalf("the answer was refused: %v", err)
	}

	got := <-waiting
	if got.err != nil {
		t.Fatalf("Ask = %v, want the answer", got.err)
	}
	var listed worker.ListDirsResult
	if err := got.result.Into(&listed); err != nil {
		t.Fatal(err)
	}
	if listed.Path != "/code" || len(listed.Entries) != 1 {
		t.Fatalf("Ask returned %+v", listed)
	}
	if n := q.Pending(); n != 0 {
		t.Fatalf("%d questions are still open after the answer arrived", n)
	}
}

// A machine's own refusal is an answer, not a transport failure: the caller is
// the one that knows how to say it to a person.
func TestAskReturnsTheMachinesRefusalAsAnAnswer(t *testing.T) {
	q := NewQueries()
	conn := newTestConn("device-refuse")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	waiting := askInBackground(ctx, q, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/etc"})
	sent := awaitQuestions(t, conn, 1)
	refusal, err := worker.Refuse(sent[0].ID, errOutsideRoots)
	if err != nil {
		t.Fatal(err)
	}
	if err := answer(t, q, conn, refusal); err != nil {
		t.Fatalf("the refusal was refused: %v", err)
	}

	got := <-waiting
	if got.err != nil {
		t.Fatalf("Ask = %v, want the machine's refusal as an answer", got.err)
	}
	if got.result.Error == "" {
		t.Fatal("the refusal came back as an empty answer")
	}
}

// A question whose answer can no longer arrive is not a question. Waiting for
// the timeout would hold an HTTP request — and the phone looking at it — for as
// long as the timeout lasts, to report something the Hub already knows.
func TestAskEndsWhenTheConnectionEnds(t *testing.T) {
	q := NewQueries()
	q.Timeout = func(string) time.Duration { return time.Minute }
	conn := newTestConn("device-drop")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	waiting := askInBackground(ctx, q, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/code"})
	sent := awaitQuestions(t, conn, 1)

	started := time.Now()
	abandoned := q.Abandon(conn)
	if len(abandoned) != 1 || abandoned[0] != sent[0].ID {
		t.Fatalf("Abandon reported %v, want the question that was open (%s)", abandoned, sent[0].ID)
	}
	got := <-waiting
	if got.err == nil {
		t.Fatal("the question was answered by a connection that had ended")
	}
	if !strings.Contains(got.err.Error(), "ended") {
		t.Fatalf("Ask = %q, want it to say the connection ended", got.err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("Ask took %s to give up, want it to end with the connection", elapsed)
	}
	if n := q.Pending(); n != 0 {
		t.Fatalf("%d questions are still open after the connection ended", n)
	}
}

// Abandon is per connection: a machine that reconnects must not lose the
// questions asked on the connection that replaced it.
//
// One device, two connections, which is the case that actually happens: the
// reconnect attaches the new socket before the old one's ending is reported, so
// a question asked in that window belongs to the new connection. A test with two
// devices passes even when Abandon matches on the device alone.
func TestAbandonLeavesOtherMachinesQuestionsAlone(t *testing.T) {
	q := NewQueries()
	q.Timeout = func(string) time.Duration { return time.Minute }
	gone, stays := newTestConn("device-reconnects"), newTestConn("device-reconnects")
	if gone.Generation() == stays.Generation() {
		t.Fatal("two connections of one machine share a generation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	first := askInBackground(ctx, q, gone, worker.QueryListDirs, worker.ListDirsParams{Path: "/a"})
	second := askInBackground(ctx, q, stays, worker.QueryListDirs, worker.ListDirsParams{Path: "/b"})
	awaitQuestions(t, gone, 1)
	sent := awaitQuestions(t, stays, 1)

	if abandoned := q.Abandon(gone); len(abandoned) != 1 {
		t.Fatalf("Abandon reported %v, want the one question asked on that connection", abandoned)
	}
	if got := <-first; got.err == nil {
		t.Fatal("the question on the ended connection was answered")
	}

	result, err := worker.Answer(sent[0].ID, worker.ListDirsResult{Path: "/b"})
	if err != nil {
		t.Fatal(err)
	}
	if err := answer(t, q, stays, result); err != nil {
		t.Fatalf("the reconnected machine's answer was refused: %v", err)
	}
	if got := <-second; got.err != nil {
		t.Fatalf("the question on the connection that replaced it was lost with it: %v", got.err)
	}
}

func TestAskTimesOutWithAReason(t *testing.T) {
	q := NewQueries()
	q.Timeout = func(string) time.Duration { return 20 * time.Millisecond }
	conn := newTestConn("device-silent")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	waiting := askInBackground(ctx, q, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/code"})
	got := <-waiting
	if got.err == nil {
		t.Fatal("a machine that never answered produced an answer")
	}
	for _, want := range []string{worker.QueryListDirs, "20ms"} {
		if !strings.Contains(got.err.Error(), want) {
			t.Fatalf("Ask = %q, want it to name %q", got.err, want)
		}
	}
	if n := q.Pending(); n != 0 {
		t.Fatalf("%d questions are still open after the timeout", n)
	}
}

// Two questions in flight at once are two questions. An answer is matched to
// the question it names, never to the one that happens to be waiting.
func TestConcurrentQuestionsKeepTheirOwnAnswers(t *testing.T) {
	q := NewQueries()
	conn := newTestConn("device-parallel")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	first := askInBackground(ctx, q, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/first"})
	second := askInBackground(ctx, q, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/second"})
	sent := awaitQuestions(t, conn, 2)

	// Which goroutine got which id is up to the scheduler, so the questions are
	// read back by the path they carry rather than by the order they went out.
	askedBy := make(map[string]string, len(sent))
	for _, question := range sent {
		var params worker.ListDirsParams
		if err := json.Unmarshal(question.Params, &params); err != nil {
			t.Fatalf("a question carried no readable params: %v", err)
		}
		askedBy[params.Path] = question.ID
	}

	// Answered out of order, newest first. The payload says which question this
	// answers, so a crossed pair cannot pass as a correct one.
	for _, path := range []string{"/second", "/first"} {
		id, ok := askedBy[path]
		if !ok {
			t.Fatalf("no question asked about %s", path)
		}
		result, err := worker.Answer(id, worker.ListDirsResult{Path: path})
		if err != nil {
			t.Fatal(err)
		}
		if err := answer(t, q, conn, result); err != nil {
			t.Fatalf("the answer about %s was refused: %v", path, err)
		}
	}

	for _, tc := range []struct {
		path    string
		waiting <-chan askOutcome
	}{{"/first", first}, {"/second", second}} {
		got := <-tc.waiting
		if got.err != nil {
			t.Fatalf("the question about %s: %v", tc.path, got.err)
		}
		var listed worker.ListDirsResult
		if err := got.result.Into(&listed); err != nil {
			t.Fatal(err)
		}
		if listed.Path != tc.path {
			t.Fatalf("the question about %s was answered with %q", tc.path, listed.Path)
		}
	}
}

// An answer to a question this Hub never asked is a wiring mistake worth
// saying out loud: silently dropping it leaves whatever is waiting to time out
// with no hint of why.
func TestRouteRefusesAnAnswerNobodyAskedFor(t *testing.T) {
	q := NewQueries()
	conn := newTestConn("device-stray")
	result, err := worker.Answer("q-999", worker.ListDirsResult{Path: "/code"})
	if err != nil {
		t.Fatal(err)
	}
	err = answer(t, q, conn, result)
	if err == nil {
		t.Fatal("an answer to an unasked question was accepted")
	}
	if !strings.Contains(err.Error(), "q-999") {
		t.Fatalf("Route = %q, want it to name the answer", err)
	}
}

func TestAskReportsAFailedWrite(t *testing.T) {
	q := NewQueries()
	conn := newTestConn("device-unwritable")
	conn.sendErr = errWriteFailed
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := q.Ask(ctx, conn, worker.QueryListDirs, worker.ListDirsParams{Path: "/code"}); err == nil {
		t.Fatal("Ask reported success for a question that never left the hub")
	}
	if n := q.Pending(); n != 0 {
		t.Fatalf("%d questions were left open by a failed write", n)
	}
}
