package node

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// RoutineAnswer is one routine request's answer from this machine's console.
type RoutineAnswer struct {
	Status      int
	ContentType string
	Body        []byte
}

// RoutineCaller runs one routine request against this machine's own console.
//
// It is the machine's half of worker.QueryRoutines: the Hub relays an already
// authorized request, and this machine runs it through the same handler its
// local console uses, so validation, scheduling, and the response shape cannot
// drift between the two paths.
type RoutineCaller func(ctx context.Context, asked worker.RoutinesParams) (RoutineAnswer, error)

// LocalRoutineCaller returns a caller that sends the request to this daemon's
// own loopback console.
//
// The loopback listener is this machine's authority: the same handlers, the same
// store, the same scheduler. The master token is this process's own, read at
// call time for the same reason the terminal and the agent adapters read it that
// way — a rotated token must not leave a stale copy in a closure.
func LocalRoutineCaller(baseURL string, token func() string) RoutineCaller {
	base := strings.TrimRight(baseURL, "/")
	// Answer before the Hub stops waiting. The Hub gives this question
	// queryTimeout(worker.QueryRoutines); a loopback call that outlives that
	// would leave the console reading a timeout while the machine may still be
	// writing — so the machine ends its own wait first and says why.
	client := &http.Client{Timeout: queryTimeout(worker.QueryRoutines) - 5*time.Second}
	return func(ctx context.Context, asked worker.RoutinesParams) (RoutineAnswer, error) {
		if err := asked.Validate(); err != nil {
			return RoutineAnswer{}, err
		}
		req, err := http.NewRequestWithContext(ctx, asked.Method, base+asked.Path, bytes.NewReader(asked.Body))
		if err != nil {
			return RoutineAnswer{}, fmt.Errorf("routine request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token())
		if len(asked.Body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			return RoutineAnswer{}, fmt.Errorf("routine request: %w", err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, worker.MaxRoutineResponse+1))
		if err != nil {
			return RoutineAnswer{}, fmt.Errorf("read routine answer: %w", err)
		}
		if len(body) > worker.MaxRoutineResponse {
			return RoutineAnswer{}, fmt.Errorf("the routine answer is %d bytes, over the %d-byte limit",
				len(body), worker.MaxRoutineResponse)
		}
		return RoutineAnswer{
			Status:      resp.StatusCode,
			ContentType: resp.Header.Get("Content-Type"),
			Body:        body,
		}, nil
	}
}
