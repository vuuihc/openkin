package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Queries is the Hub's table of the questions it has asked machines and not yet
// had answered.
//
// The channel is otherwise one-way in each direction: commands down, reports up.
// A question needs both — an answer that belongs to the question that asked it —
// and that pairing is the whole of this file. It lives on the Hub rather than in
// the connection because the connection is replaced on every reconnect, and a
// question asked on the connection that just ended must be settled, not lost.
type Queries struct {
	// Timeout is how long one question waits for its answer, by method. Nil uses
	// queryTimeout, which knows how long the methods take.
	Timeout func(method string) time.Duration

	mu   sync.Mutex
	next uint64
	open map[string]*question
}

// question is one question in flight.
type question struct {
	deviceID string
	// gen is the connection this question was asked on. A machine that
	// reconnects gets a new one, which is what keeps a question asked on the
	// socket that ended from being settled by the socket that replaced it.
	gen uint64
	id  string
	// answer is buffered, and written at most once: whoever removes the entry
	// from the table is the writer, so a delivery never blocks and a question is
	// never answered twice.
	answer chan answerOutcome
}

// answerOutcome is how one question ended: the machine's reply, or the reason
// there is none.
type answerOutcome struct {
	result worker.QueryResult
	err    error
}

// NewQueries returns an empty table.
func NewQueries() *Queries {
	return &Queries{open: make(map[string]*question)}
}

// Ask puts one question to one machine and waits for its answer.
//
// A machine's refusal comes back as a result, not as an error: the reason is
// that machine's — it is the party that knows where its own boundary is — and
// the caller decides how to put it to a person. An error means there is no
// answer at all: the machine is not connected, the connection ended, or the wait
// ran out.
func (q *Queries) Ask(ctx context.Context, sender Sender, method string, params any) (worker.QueryResult, error) {
	if sender == nil {
		return worker.QueryResult{}, errors.New("no connection to ask on")
	}
	raw, err := encodeParams(params)
	if err != nil {
		return worker.QueryResult{}, err
	}
	waiting := q.track(sender)
	frame, err := worker.NewFrame("query", worker.Query{ID: waiting.id, Method: method, Params: raw})
	if err != nil {
		q.drop(waiting)
		return worker.QueryResult{}, err
	}
	if err := sender.Send(ctx, frame); err != nil {
		q.drop(waiting)
		return worker.QueryResult{}, fmt.Errorf("ask %s: %w", sender.DeviceID(), err)
	}

	timeout := q.timeout(method)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case got := <-waiting.answer:
		return got.result, got.err
	case <-timer.C:
		if q.drop(waiting) {
			return worker.QueryResult{}, fmt.Errorf("%s did not answer %s within %s",
				sender.DeviceID(), method, timeout)
		}
		// The answer landed as the timer fired. It is still the answer.
		got := <-waiting.answer
		return got.result, got.err
	case <-ctx.Done():
		if q.drop(waiting) {
			return worker.QueryResult{}, ctx.Err()
		}
		got := <-waiting.answer
		return got.result, got.err
	}
}

// Route hands one machine's answer to the question that asked for it.
func (q *Queries) Route(_ context.Context, sender Sender, frame worker.Frame) error {
	if frame.Kind != "query.result" {
		return fmt.Errorf("queries do not handle frame kind %q", frame.Kind)
	}
	result, err := Decode[worker.QueryResult](frame)
	if err != nil {
		return err
	}
	if err := result.Validate(); err != nil {
		return err
	}
	q.mu.Lock()
	key := questionKey(sender.DeviceID(), result.ID)
	waiting := q.open[key]
	delete(q.open, key)
	q.mu.Unlock()
	if waiting == nil {
		// An answer to a question this Hub never asked is a wiring mistake worth
		// saying out loud: an answer that is merely dropped leaves whoever was
		// waiting to time out with no hint of why.
		return fmt.Errorf("%s answered question %s, which it was not asked", sender.DeviceID(), result.ID)
	}
	waiting.answer <- answerOutcome{result: result}
	return nil
}

// Abandon ends every question asked of one connection, because the answer can no
// longer arrive. It returns the ids it ended, for the log.
//
// Waiting for the timeout instead would hold an HTTP request — and the phone
// looking at it — for as long as the timeout lasts, to report something the Hub
// already knows.
//
// It is scoped to one connection, not to one machine, and that is the same rule
// Turns and Approvals follow: a reconnect attaches the new socket before the old
// one's ending is reported, so a question put to the machine in between is on the
// new connection and must survive. Matching on the device alone would settle it
// with the old socket's death, and the answer would then arrive for a question
// that is no longer in the table.
func (q *Queries) Abandon(sender Sender) []string {
	if sender == nil {
		return nil
	}
	deviceID, gen := sender.DeviceID(), sender.Generation()
	q.mu.Lock()
	var abandoned []*question
	for key, waiting := range q.open {
		if waiting.deviceID == deviceID && waiting.gen == gen {
			delete(q.open, key)
			abandoned = append(abandoned, waiting)
		}
	}
	q.mu.Unlock()

	ids := make([]string, 0, len(abandoned))
	for _, waiting := range abandoned {
		ids = append(ids, waiting.id)
		waiting.answer <- answerOutcome{err: fmt.Errorf(
			"%s did not answer %s: the connection to it ended", deviceID, waiting.id)}
	}
	return ids
}

// Pending counts the questions still waiting for an answer.
func (q *Queries) Pending() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.open)
}

// track registers a question that is about to be sent.
func (q *Queries) track(sender Sender) *question {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.open == nil {
		q.open = make(map[string]*question)
	}
	q.next++
	waiting := &question{
		deviceID: sender.DeviceID(),
		gen:      sender.Generation(),
		id:       "q-" + strconv.FormatUint(q.next, 10),
		answer:   make(chan answerOutcome, 1),
	}
	q.open[questionKey(waiting.deviceID, waiting.id)] = waiting
	return waiting
}

// drop removes a question from the table, and reports whether it was still
// there. False means somebody else already settled it, and the answer is in its
// channel waiting to be read.
func (q *Queries) drop(waiting *question) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	key := questionKey(waiting.deviceID, waiting.id)
	if q.open[key] != waiting {
		return false
	}
	delete(q.open, key)
	return true
}

// questionKey names one question. The device is part of it because the ids are
// the Hub's own counter: two machines can be asked different questions that
// share an id, and neither answer may be handed to the other.
func questionKey(deviceID, id string) string {
	return deviceID + "\x00" + id
}

// queryTimeout is how long a question waits for its answer.
//
// The methods differ by orders of magnitude — a listing is a walk over a
// directory, a clone is a network transfer — so one number would be wrong for
// one of them: too short and a slow clone is reported as a missing machine, too
// long and a machine that is not answering holds a phone's screen.
//
// The session questions (QueryAgentSessions, QueryAgentHistory) were considered
// for a budget of their own and deliberately keep this one, on a measurement
// rather than an estimate: listing all three of a real machine's catalogs —
// claude-code, codex and droid, 1,975 files and 1.7 GB of transcripts between
// them, at the widest page the wire allows — takes 1.8s, and one history page
// 0.9s, repeatably. That is eight times the headroom this budget leaves, and the
// work is bounded by the catalog's own file and line caps rather than by how
// much history a person has. What would change the answer is a provider whose
// files are pathological rather than numerous, which the catalog layer would
// have to bound by the requested limit; that is recorded in the S4 notes rather
// than paid for here with a minute of a phone's screen.
func queryTimeout(method string) time.Duration {
	switch method {
	case worker.QueryRepoPrepare:
		return 5 * time.Minute
	case worker.QueryPRPublish:
		// A publish is the one question whose answer arrives after something
		// irreversible has already happened on the machine. It contains a push — an
		// unbounded network transfer — and then a gh invocation this machine allows
		// 30s of its own, so the 15s a listing gets would give up while the machine
		// was still working: the Hub would report a machine that is not answering,
		// and the branch would land anyway, with nothing recorded on this side. The
		// person can wait; they are watching a sheet they just tapped.
		return 2 * time.Minute
	default:
		return 15 * time.Second
	}
}

func (q *Queries) timeout(method string) time.Duration {
	if q.Timeout != nil {
		if d := q.Timeout(method); d > 0 {
			return d
		}
	}
	return queryTimeout(method)
}

// encodeParams renders one question's params. A method with no params of its own
// sends none, which the answering side reads as its zero value.
func encodeParams(params any) (json.RawMessage, error) {
	if params == nil {
		return nil, nil
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("encode query params: %w", err)
	}
	if len(raw) > worker.MaxQueryParams {
		return nil, fmt.Errorf("query params exceeds %d bytes", worker.MaxQueryParams)
	}
	return raw, nil
}

// hasParams reports whether a question carried a payload at all.
func hasParams(raw json.RawMessage) bool {
	return len(strings.TrimSpace(string(raw))) > 0
}
