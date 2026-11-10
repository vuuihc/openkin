package node

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// TaskReader reads the tasks that live on this machine.
//
// It is the machine's half of worker.QueryTaskDetail and QueryTaskEvents. The
// same reasoning as routines applies: a routine run is a task in this machine's
// store, the Hub relays the list, and a row in that list can only be opened
// where it lives. Reading it through this machine's own console, rather than
// through a second query implementation, is what keeps the transcript a console
// reads here identical to the one it reads on the machine itself.
type TaskReader interface {
	// Task returns one task row, as this console answers GET /api/tasks/{id}.
	Task(ctx context.Context, id string) (RoutineAnswer, error)
	// TaskEvents returns the task's transcript after sinceSeq, as this console
	// answers GET /api/tasks/{id}/events.
	TaskEvents(ctx context.Context, id string, sinceSeq int) (RoutineAnswer, error)
}

// LocalTaskReader returns a reader that asks this daemon's own loopback console.
//
// The loopback listener is this machine's authority: the same handlers, the
// same store, the same scope checks. The master token is read at call time for
// the same reason the routine caller reads it that way — a rotated token must
// not leave a stale copy in a closure.
func LocalTaskReader(baseURL string, token func() string) TaskReader {
	return &localTaskReader{
		base:  strings.TrimRight(baseURL, "/"),
		token: token,
		// Answer before the Hub stops waiting. The Hub gives each of these
		// questions queryTimeout; a loopback read that outlives it would leave
		// the console reading a timeout for an answer that may still arrive.
		client: &http.Client{Timeout: queryTimeout(worker.QueryTaskEvents) - 5*time.Second},
	}
}

type localTaskReader struct {
	base   string
	token  func() string
	client *http.Client
}

func (l *localTaskReader) Task(ctx context.Context, id string) (RoutineAnswer, error) {
	if err := (worker.TaskDetailParams{ID: id}).Validate(); err != nil {
		return RoutineAnswer{}, err
	}
	return l.get(ctx, "/api/tasks/"+url.PathEscape(id))
}

func (l *localTaskReader) TaskEvents(ctx context.Context, id string, sinceSeq int) (RoutineAnswer, error) {
	asked := worker.TaskEventsParams{ID: id, SinceSeq: sinceSeq}
	if err := asked.Validate(); err != nil {
		return RoutineAnswer{}, err
	}
	path := "/api/tasks/" + url.PathEscape(id) + "/events"
	if sinceSeq > 0 {
		path += "?since_seq=" + strconv.Itoa(sinceSeq)
	}
	return l.get(ctx, path)
}

// get reads one console answer, bounded by the frame it has to travel in.
func (l *localTaskReader) get(ctx context.Context, path string) (RoutineAnswer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.base+path, nil)
	if err != nil {
		return RoutineAnswer{}, fmt.Errorf("task read: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+l.token())
	resp, err := l.client.Do(req)
	if err != nil {
		return RoutineAnswer{}, fmt.Errorf("task read: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, worker.MaxTaskResponse+1))
	if err != nil {
		return RoutineAnswer{}, fmt.Errorf("read task answer: %w", err)
	}
	if len(body) > worker.MaxTaskResponse {
		return RoutineAnswer{}, fmt.Errorf("the task answer is %d bytes, over the %d-byte limit",
			len(body), worker.MaxTaskResponse)
	}
	return RoutineAnswer{
		Status:      resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
		Body:        body,
	}, nil
}
