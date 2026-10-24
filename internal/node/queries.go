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
	id       string
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
	waiting := q.track(sender.DeviceID())
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
func (q *Queries) Abandon(sender Sender) []string {
	if sender == nil {
		return nil
	}
	deviceID := sender.DeviceID()
	q.mu.Lock()
	var abandoned []*question
	for key, waiting := range q.open {
		if waiting.deviceID == deviceID {
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
func (q *Queries) track(deviceID string) *question {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.open == nil {
		q.open = make(map[string]*question)
	}
	q.next++
	waiting := &question{
		deviceID: deviceID,
		id:       "q-" + strconv.FormatUint(q.next, 10),
		answer:   make(chan answerOutcome, 1),
	}
	q.open[questionKey(deviceID, waiting.id)] = waiting
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
func queryTimeout(method string) time.Duration {
	switch method {
	case "repo.prepare":
		return 5 * time.Minute
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
