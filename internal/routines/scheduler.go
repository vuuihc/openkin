// Package routines hosts the background ticker that dispatches due Routines
// through the shared Task engine (ADR 0011).
package routines

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

// DefaultTickInterval is how often the scheduler scans for due routines.
const DefaultTickInterval = 30 * time.Second

// MaxCatchUpSteps bounds how many interval steps we advance next_due_at when
// the process was down for a long time (prevents stampede on restart).
const MaxCatchUpSteps = 3

// JitterFraction is applied per-routine when advancing next_due_at (± fraction).
const JitterFraction = 0.05

// Engine is the task-creation surface the scheduler needs.
type Engine interface {
	Create(ctx context.Context, req task.CreateRequest) (store.Task, error)
}

// Scheduler fires due routines onto the shared FIFO queue.
type Scheduler struct {
	Store  *store.Store
	Engine Engine
	// Interval between scans. Zero → DefaultTickInterval.
	Interval time.Duration
	// Clock for tests. nil → time.Now.
	Clock func() time.Time
	// Logf optional; defaults to log.Printf.
	Logf func(format string, args ...any)
}

// StartLoop runs Tick every interval until ctx is done.
// Modelled on task.Engine.StartExpiryLoop.
func (s *Scheduler) StartLoop(ctx context.Context, interval time.Duration) {
	if s == nil || s.Store == nil || s.Engine == nil {
		return
	}
	if interval <= 0 {
		interval = s.Interval
	}
	if interval <= 0 {
		interval = DefaultTickInterval
	}
	go func() {
		// Small initial delay so startup recovery settles first.
		t := time.NewTimer(2 * time.Second)
		for {
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
				if err := s.Tick(ctx); err != nil && ctx.Err() == nil {
					s.logf("routines: tick: %v", err)
				}
				t.Reset(interval)
			}
		}
	}()
}

// Tick dispatches every due routine once and advances next_due_at with
// bounded catch-up + per-routine jitter.
func (s *Scheduler) Tick(ctx context.Context) error {
	if s == nil || s.Store == nil || s.Engine == nil {
		return nil
	}
	now := s.now()
	nowMs := now.UnixMilli()
	due, err := s.Store.ListDueRoutines(ctx, nowMs, 50)
	if err != nil {
		return err
	}
	for _, r := range due {
		if err := s.dispatch(ctx, r, now); err != nil {
			s.logf("routines: dispatch %s: %v", r.ID, err)
			// Still advance schedule so a permanent create error does not hot-loop.
			_ = s.advanceSchedule(ctx, r, now)
		}
	}
	return nil
}

func (s *Scheduler) dispatch(ctx context.Context, r store.Routine, now time.Time) error {
	prompt := r.Prompt
	if !strings.Contains(prompt, "noteworthy:") {
		prompt = prompt + task.ReportSignalTrailer
	}
	title := r.Title
	if title == "" {
		title = "Routine"
	}
	titlePtr := title
	req := task.CreateRequest{
		Agent:          r.Agent,
		Cwd:            r.Cwd,
		Prompt:         prompt,
		Title:          &titlePtr,
		PermissionMode: r.PermissionMode,
		ProjectID:      r.ProjectID,
		RoutineID:      r.ID,
		UserPrompt:     r.Prompt, // show original prompt without trailer in timeline
	}
	if _, err := s.Engine.Create(ctx, req); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	return s.advanceSchedule(ctx, r, now)
}

// advanceSchedule sets last_run_at=now and next_due_at with bounded catch-up + jitter.
func (s *Scheduler) advanceSchedule(ctx context.Context, r store.Routine, now time.Time) error {
	nowMs := now.UnixMilli()
	intervalMs := r.IntervalSecs * 1000
	if intervalMs <= 0 {
		intervalMs = 60_000
	}
	next := r.NextDueAt
	// Catch up at most MaxCatchUpSteps intervals past "now" so a long outage
	// does not enqueue MaxCatchUpSteps runs at once — we already dispatched one.
	steps := 0
	for next <= nowMs && steps < MaxCatchUpSteps {
		next += intervalMs
		steps++
	}
	if next <= nowMs {
		// Still behind after max steps: jump to now + one interval.
		next = nowMs + intervalMs
	}
	next = applyJitter(next, intervalMs, JitterFraction)
	return s.Store.UpdateRoutine(ctx, r.ID, store.RoutinePatch{
		LastRunAt: &nowMs,
		NextDueAt: &next,
	})
}

func applyJitter(nextMs, intervalMs int64, fraction float64) int64 {
	if intervalMs <= 0 || fraction <= 0 {
		return nextMs
	}
	// Uniform in [-fraction, +fraction] of interval.
	span := int64(math.Round(float64(intervalMs) * fraction))
	if span <= 0 {
		return nextMs
	}
	// crypto/rand int63n(2*span+1) - span
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nextMs
	}
	n := int64(binary.LittleEndian.Uint64(b[:]) & 0x7fffffffffffffff)
	mod := n % (2*span + 1)
	return nextMs + (mod - span)
}

func (s *Scheduler) now() time.Time {
	if s.Clock != nil {
		return s.Clock()
	}
	return time.Now()
}

func (s *Scheduler) logf(format string, args ...any) {
	if s.Logf != nil {
		s.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}
