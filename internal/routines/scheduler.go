// Package routines hosts the background ticker that dispatches due Routines
// through the shared Task engine (ADR 0011).
package routines

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
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
	// ValidateCreate is an optional defense-in-depth check shared with the
	// HTTP/MCP task creation boundary.
	ValidateCreate func(context.Context, task.CreateRequest) error
	// OnCreateFailed cleans up metadata reserved before task creation.
	OnCreateFailed func(context.Context, string) error
	// Interval between scans. Zero → DefaultTickInterval.
	Interval time.Duration
	// Clock for tests. nil → time.Now.
	Clock func() time.Time
	// Logf optional; defaults to log.Printf.
	Logf func(format string, args ...any)
	// Concurrency bounds Routine work independently from interactive tasks.
	// Zero means one, preserving an interactive slot in the shared engine.
	Concurrency int
	// TotalConcurrency is the task engine limit. One slot is reserved for
	// interactive work whenever the engine has more than one slot.
	TotalConcurrency int

	mu        sync.Mutex
	tickMu    sync.Mutex
	lastError string
	manualSeq atomic.Int64
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
	s.tickMu.Lock()
	defer s.tickMu.Unlock()

	now := s.now()
	nowMs := now.UnixMilli()
	limit := s.Concurrency
	if limit <= 0 {
		limit = 1
	}
	if s.TotalConcurrency == 1 {
		// There is no background capacity without stealing the only
		// interactive slot. Leave the due row visible as backlog instead.
		return nil
	}
	if s.TotalConcurrency > 1 && limit >= s.TotalConcurrency {
		limit = s.TotalConcurrency - 1
	}
	inFlight, err := s.Store.CountRoutineInFlight(ctx)
	if err != nil {
		s.recordError(err)
		return err
	}
	available := limit - inFlight
	used, err := s.recoverManualDispatches(ctx, now, available)
	if err != nil {
		s.recordError(err)
		return err
	}
	available -= used
	if available <= 0 {
		return nil
	}
	due, err := s.Store.ListDueRoutines(ctx, nowMs, available*4)
	if err != nil {
		s.recordError(err)
		return err
	}
	for _, r := range due {
		if available <= 0 {
			break
		}
		token := fmt.Sprintf("%d:%s", now.UnixNano(), r.ID)
		claimed, err := s.Store.ClaimDueRoutine(ctx, r.ID, token, nowMs, int64(2*time.Minute/time.Millisecond))
		if err != nil {
			if errors.Is(err, store.ErrConflict) {
				continue
			}
			s.recordError(err)
			return err
		}
		available--
		if err := s.dispatch(ctx, claimed, token, now); err != nil {
			s.recordError(err)
			s.logf("routines: dispatch %s: %v", r.ID, err)
		}
	}
	return nil
}

func (s *Scheduler) recoverManualDispatches(ctx context.Context, now time.Time, available int) (int, error) {
	pending, err := s.Store.ListPendingManualRoutineDispatches(ctx, available*4)
	if err != nil {
		return 0, err
	}
	used := 0
	for _, dispatch := range pending {
		routine, err := s.Store.GetRoutine(ctx, dispatch.RoutineID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				_ = s.Store.CompleteRoutineDispatch(ctx, dispatch.RoutineID, dispatch.DueAt, "failed")
				continue
			}
			return used, err
		}
		existing, err := s.Store.GetTask(ctx, dispatch.TaskID)
		if err == nil {
			if dispatch.State == "mcp_manual_pending" {
				if _, originErr := s.Store.GetMCPTaskOrigin(ctx, dispatch.TaskID); originErr != nil {
					_ = s.Store.CompleteRoutineDispatch(ctx, routine.ID, dispatch.DueAt, "failed")
					_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{
						LastRunAt:   &dispatch.CreatedAt,
						LastOutcome: stringPtr("failed"),
						LastError:   stringPtr("MCP task origin is unavailable"),
					})
					continue
				}
			}
			if existing.Status == task.StatusFailed || existing.Status == task.StatusCanceled {
				_ = s.Store.CompleteRoutineDispatch(ctx, dispatch.RoutineID, dispatch.DueAt, "failed")
				_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{
					LastRunAt:   &dispatch.CreatedAt,
					LastOutcome: stringPtr("failed"),
					LastError:   stringPtr(fmt.Sprintf("recovered manual dispatch has terminal task status %q", existing.Status)),
				})
			} else {
				_ = s.Store.CompleteRoutineDispatch(ctx, dispatch.RoutineID, dispatch.DueAt, "dispatched")
				_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{LastRunAt: &dispatch.CreatedAt})
			}
			continue
		}
		if !errors.Is(err, store.ErrNotFound) {
			return used, err
		}
		if dispatch.State == "mcp_manual_pending" {
			if _, originErr := s.Store.GetMCPTaskOrigin(ctx, dispatch.TaskID); originErr != nil {
				_ = s.Store.CompleteRoutineDispatch(ctx, routine.ID, dispatch.DueAt, "failed")
				_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{
					LastRunAt:   &dispatch.CreatedAt,
					LastOutcome: stringPtr("failed"),
					LastError:   stringPtr("MCP task origin is unavailable"),
				})
				continue
			}
		}
		if used >= available {
			break
		}
		req := s.routineCreateRequest(routine, dispatch.TaskID)
		if s.ValidateCreate != nil {
			if err := s.ValidateCreate(ctx, req); err != nil {
				_ = s.Store.CompleteRoutineDispatch(ctx, routine.ID, dispatch.DueAt, "failed")
				_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{
					LastRunAt:   &dispatch.CreatedAt,
					LastOutcome: stringPtr("failed"),
					LastError:   stringPtr(err.Error()),
				})
				continue
			}
		}
		if _, err := s.Engine.Create(ctx, req); err != nil {
			if s.OnCreateFailed != nil {
				_ = s.OnCreateFailed(ctx, dispatch.TaskID)
			}
			_ = s.Store.CompleteRoutineDispatch(ctx, routine.ID, dispatch.DueAt, "failed")
			_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{
				LastRunAt:   &dispatch.CreatedAt,
				LastOutcome: stringPtr("failed"),
				LastError:   stringPtr(err.Error()),
			})
			continue
		}
		if err := s.Store.CompleteRoutineDispatch(ctx, routine.ID, dispatch.DueAt, "dispatched"); err != nil {
			return used, err
		}
		_ = s.Store.UpdateRoutine(ctx, routine.ID, store.RoutinePatch{LastRunAt: &dispatch.CreatedAt})
		used++
	}
	return used, nil
}

func (s *Scheduler) dispatch(ctx context.Context, r store.Routine, token string, now time.Time) error {
	next := s.nextDue(r, now)
	if strings.EqualFold(r.MissedRunPolicy, "skip") &&
		now.UnixMilli()-r.NextDueAt > r.IntervalSecs*1000 {
		if err := s.Store.CompleteRoutineClaim(ctx, r, token, now.UnixMilli(), next, "skipped", "missed run coalesced by skip policy"); err != nil {
			return err
		}
		return nil
	}
	dispatch, _, err := s.Store.BeginRoutineDispatch(
		ctx, r.ID, r.NextDueAt, ulid.Make().String(), now.UnixMilli(),
	)
	if err != nil {
		return err
	}
	if _, err := s.Store.GetTask(ctx, dispatch.TaskID); err == nil {
		existing, err := s.Store.GetTask(ctx, dispatch.TaskID)
		if err != nil {
			return err
		}
		if dispatch.State == "failed" || existing.Status == task.StatusFailed || existing.Status == task.StatusCanceled {
			message := fmt.Sprintf("recovered routine dispatch has terminal task status %q", existing.Status)
			_ = s.Store.CompleteRoutineDispatch(ctx, r.ID, r.NextDueAt, "failed")
			return s.Store.CompleteRoutineClaim(ctx, r, token, now.UnixMilli(), next, "failed", message)
		}
		if err := s.Store.CompleteRoutineDispatch(ctx, r.ID, r.NextDueAt, "dispatched"); err != nil {
			return err
		}
		return s.Store.CompleteRoutineClaim(ctx, r, token, now.UnixMilli(), next, "dispatched", "")
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	req := s.routineCreateRequest(r, dispatch.TaskID)
	if s.ValidateCreate != nil {
		if err := s.ValidateCreate(ctx, req); err != nil {
			_ = s.Store.CompleteRoutineDispatch(ctx, r.ID, r.NextDueAt, "failed")
			completeErr := s.Store.CompleteRoutineClaim(ctx, r, token, now.UnixMilli(), next, "failed", err.Error())
			if completeErr != nil {
				return fmt.Errorf("validate: %v; release claim: %w", err, completeErr)
			}
			return fmt.Errorf("validate: %w", err)
		}
	}
	if _, err := s.Engine.Create(ctx, req); err != nil {
		_ = s.Store.CompleteRoutineDispatch(ctx, r.ID, r.NextDueAt, "failed")
		completeErr := s.Store.CompleteRoutineClaim(ctx, r, token, now.UnixMilli(), next, "failed", err.Error())
		if completeErr != nil {
			return fmt.Errorf("create: %v; release claim: %w", err, completeErr)
		}
		return fmt.Errorf("create: %w", err)
	}
	if err := s.Store.CompleteRoutineDispatch(ctx, r.ID, r.NextDueAt, "dispatched"); err != nil {
		return err
	}
	return s.Store.CompleteRoutineClaim(ctx, r, token, now.UnixMilli(), next, "dispatched", "")
}

// nextDue applies explicit missed-run semantics. Both policies emit at most
// one run after downtime; skip suppresses an overdue run, coalesce executes it.
func (s *Scheduler) nextDue(r store.Routine, now time.Time) int64 {
	nowMs := now.UnixMilli()
	intervalMs := r.IntervalSecs * 1000
	if intervalMs <= 0 {
		intervalMs = 60_000
	}
	if strings.EqualFold(r.MissedRunPolicy, "coalesce") || strings.EqualFold(r.MissedRunPolicy, "skip") || r.MissedRunPolicy == "" {
		return applyJitter(nowMs+intervalMs, intervalMs, JitterFraction)
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
	return next
}

// RunNow dispatches a manual Routine through the same background capacity
// budget as scheduled work. It deliberately leaves next_due_at unchanged.
func (s *Scheduler) RunNow(ctx context.Context, routineID string) (store.Task, error) {
	return s.runNow(ctx, routineID, nil, false)
}

// RunNowWithOrigin is used by protocol adapters that need to persist the
// authenticated origin before the dispatch is considered complete.
func (s *Scheduler) RunNowWithOrigin(ctx context.Context, routineID string, onCreated func(store.Task) error) (store.Task, error) {
	return s.runNow(ctx, routineID, onCreated, true)
}

func (s *Scheduler) runNow(ctx context.Context, routineID string, onCreated func(store.Task) error, requireOrigin bool) (store.Task, error) {
	if s == nil || s.Store == nil || s.Engine == nil {
		return store.Task{}, fmt.Errorf("routine services unavailable")
	}
	s.tickMu.Lock()
	defer s.tickMu.Unlock()

	limit := s.Concurrency
	if limit <= 0 {
		limit = 1
	}
	if s.TotalConcurrency == 1 {
		return store.Task{}, fmt.Errorf("routine background lane has no available slot: %w", store.ErrConflict)
	}
	if s.TotalConcurrency > 1 && limit >= s.TotalConcurrency {
		limit = s.TotalConcurrency - 1
	}
	inFlight, err := s.Store.CountRoutineInFlight(ctx)
	if err != nil {
		return store.Task{}, err
	}
	if inFlight >= limit {
		return store.Task{}, fmt.Errorf("routine background lane is full: %w", store.ErrConflict)
	}
	r, err := s.Store.GetRoutine(ctx, routineID)
	if err != nil {
		return store.Task{}, err
	}
	now := s.now()
	lastRunAt := now.UnixMilli()
	dueAt := lastRunAt*1000 + s.manualSeq.Add(1)
	var dispatch store.RoutineDispatch
	if requireOrigin {
		dispatch, _, err = s.Store.BeginMCPRoutineDispatch(ctx, r.ID, dueAt, ulid.Make().String(), lastRunAt)
	} else {
		dispatch, _, err = s.Store.BeginManualRoutineDispatch(ctx, r.ID, dueAt, ulid.Make().String(), lastRunAt)
	}
	if err != nil {
		return store.Task{}, err
	}
	if existing, err := s.Store.GetTask(ctx, dispatch.TaskID); err == nil {
		if dispatch.State == "failed" || existing.Status == task.StatusFailed || existing.Status == task.StatusCanceled {
			return store.Task{}, fmt.Errorf("recovered routine dispatch has terminal task status %q: %w", existing.Status, store.ErrConflict)
		}
		return existing, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.Task{}, err
	}
	req := s.routineCreateRequest(r, dispatch.TaskID)
	if s.ValidateCreate != nil {
		if err := s.ValidateCreate(ctx, req); err != nil {
			_ = s.Store.CompleteRoutineDispatch(ctx, r.ID, dueAt, "failed")
			return store.Task{}, err
		}
	}
	if onCreated != nil {
		if err := onCreated(store.Task{
			ID:        dispatch.TaskID,
			RoutineID: r.ID,
			CreatedAt: lastRunAt,
		}); err != nil {
			_ = s.Store.CompleteRoutineDispatch(ctx, r.ID, dueAt, "failed")
			return store.Task{}, err
		}
	}
	created, err := s.Engine.Create(ctx, req)
	if err != nil {
		if s.OnCreateFailed != nil {
			_ = s.OnCreateFailed(ctx, dispatch.TaskID)
		}
		_ = s.Store.CompleteRoutineDispatch(ctx, r.ID, dueAt, "failed")
		return store.Task{}, err
	}
	if err := s.Store.CompleteRoutineDispatch(ctx, r.ID, dueAt, "dispatched"); err != nil {
		return store.Task{}, err
	}
	_ = s.Store.UpdateRoutine(ctx, r.ID, store.RoutinePatch{LastRunAt: &lastRunAt})
	return created, nil
}

func (s *Scheduler) routineCreateRequest(r store.Routine, taskID string) task.CreateRequest {
	prompt := r.Prompt
	if !strings.Contains(prompt, "noteworthy:") {
		prompt += task.ReportSignalTrailer
	}
	title := r.Title
	if title == "" {
		title = "Routine"
	}
	return task.CreateRequest{
		ID:             taskID,
		Agent:          r.Agent,
		Cwd:            r.Cwd,
		Prompt:         prompt,
		Title:          &title,
		PermissionMode: r.PermissionMode,
		ProjectID:      r.ProjectID,
		RoutineID:      r.ID,
		UserPrompt:     r.Prompt,
	}
}

func stringPtr(value string) *string {
	return &value
}

// Health returns scheduler backlog plus the latest scheduler error.
func (s *Scheduler) Health(ctx context.Context) (store.RoutineHealth, error) {
	health, err := s.Store.RoutineHealthSnapshot(ctx)
	if err != nil {
		return store.RoutineHealth{}, err
	}
	s.mu.Lock()
	health.LastSchedulerError = s.lastError
	s.mu.Unlock()
	return health, nil
}

func (s *Scheduler) recordError(err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	s.lastError = err.Error()
	s.mu.Unlock()
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
