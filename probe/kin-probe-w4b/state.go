package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

// EventKey identifies one event: seq is only unique within an event_epoch.
type EventKey struct {
	Epoch int64
	Seq   int64
}

// MessageAccumulator applies the documented message rule: partial chunks
// concatenate in seq order, and a later non-partial message replaces the
// accumulated text instead of appending to it.
type MessageAccumulator struct {
	PartialChunks int
	PartialText   string
	FinalText     string
	HaveFinal     bool
}

func (m *MessageAccumulator) Apply(ev TaskEvent) {
	if ev.Type != "message" {
		return
	}
	p := ev.Payload
	if p.Partial != nil && *p.Partial {
		m.PartialChunks++
		m.PartialText += p.Text
		return
	}
	if p.Text != "" {
		m.FinalText = p.Text
		m.PartialText = ""
		m.HaveFinal = true
	}
}

// TaskTracker reconciles one task's durable event log. It keeps the highest
// epoch seen, expects contiguous seq within an epoch, and records a gap rather
// than silently accepting one. A higher epoch discards the tail: the documented
// rule is to refetch from zero, and appended frames after a tail rewrite reuse
// seq values from the rewrite point.
type TaskTracker struct {
	Task      Task
	HasTask   bool
	Epoch     int64
	HaveEpoch bool
	NextSeq   int64
	Events    map[EventKey]TaskEvent
	Order     []EventKey
	Gaps      []string
	Messages  MessageAccumulator
}

func NewTaskTracker() *TaskTracker {
	return &TaskTracker{Events: make(map[EventKey]TaskEvent)}
}

func (t *TaskTracker) ApplyTask(task Task) {
	t.Task = task
	t.HasTask = true
}

// ApplyEvent records a live event. It returns true when a newer epoch reset
// the accumulated tail.
func (t *TaskTracker) ApplyEvent(ev TaskEvent) (epochReset bool) {
	if !t.HaveEpoch {
		t.HaveEpoch = true
		t.Epoch = ev.EventEpoch
		t.NextSeq = ev.Seq
	} else if ev.EventEpoch > t.Epoch {
		t.Epoch = ev.EventEpoch
		t.NextSeq = ev.Seq
		t.Events = make(map[EventKey]TaskEvent)
		t.Order = nil
		t.Messages = MessageAccumulator{}
		epochReset = true
	} else if ev.EventEpoch < t.Epoch {
		// A frame from a replaced epoch is stale; the tail was refetched.
		return false
	}

	key := EventKey{Epoch: ev.EventEpoch, Seq: ev.Seq}
	if _, seen := t.Events[key]; seen {
		return epochReset
	}
	if ev.Seq > t.NextSeq {
		t.Gaps = append(t.Gaps, fmt.Sprintf("seq %d..%d missing", t.NextSeq, ev.Seq-1))
	}
	if ev.Seq >= t.NextSeq {
		t.NextSeq = ev.Seq + 1
	}
	t.Events[key] = ev
	t.Order = append(t.Order, key)
	t.Messages.Apply(ev)
	return epochReset
}

// FeedState applies global change-feed pages. The cursor advances only here,
// never from a push frame, and must never move backwards.
type FeedState struct {
	Cursor  int64
	Started bool
	Tasks   map[string]Task
	Deleted map[string]bool
	Pages   int
}

func NewFeedState() *FeedState {
	return &FeedState{Tasks: make(map[string]Task), Deleted: make(map[string]bool)}
}

func (f *FeedState) Apply(page ChangePage) error {
	if f.Started && page.NextCursor < f.Cursor {
		return fmt.Errorf("feed cursor moved backwards: %d -> %d", f.Cursor, page.NextCursor)
	}
	for _, task := range page.Sessions {
		f.Tasks[task.ID] = task
		delete(f.Deleted, task.ID)
	}
	for _, id := range page.Deleted {
		delete(f.Tasks, id)
		f.Deleted[id] = true
	}
	f.Cursor = page.NextCursor
	f.Started = true
	f.Pages++
	return nil
}

// DrainFeed pages from since (nil means from the beginning) until has_more is
// false, applying every page. It refuses a page that reports more work without
// advancing the cursor, so an unresponsive daemon cannot spin the client.
func DrainFeed(ctx context.Context, fetch func(since *int64) (ChangePage, error), since *int64, apply func(ChangePage) error) (int, error) {
	cursor := since
	pages := 0
	for {
		if err := ctx.Err(); err != nil {
			return pages, err
		}
		page, err := fetch(cursor)
		if err != nil {
			return pages, err
		}
		if cursor != nil && page.NextCursor == *cursor && page.HasMore {
			return pages, fmt.Errorf("feed reported has_more at unchanged cursor %d", page.NextCursor)
		}
		if err := apply(page); err != nil {
			return pages, err
		}
		pages++
		if pages > 10000 {
			return pages, fmt.Errorf("feed did not converge after %d pages", pages)
		}
		next := page.NextCursor
		cursor = &next
		if !page.HasMore {
			return pages, nil
		}
	}
}

// LiveState is the mutex-guarded view a stream pump writes and the driver
// reads. Frames for other tasks are counted but not tracked. Before the
// acceptance task exists the state buffers incoming frames; SetTaskID replays
// them so opening the stream first (the documented order) loses nothing.
type LiveState struct {
	mu              sync.Mutex
	TaskID          string
	pending         []SSEEvent
	droppedPending  int
	ignoreStreamErr bool
	Tracker         *TaskTracker
	Approvals       map[string]Approval
	Frames          int
	TaskFrames      int
	Comments        int
	Unknown         int
	StreamErr       error
	KindCounts      map[string]int
	eventNames      map[string]int
	ApprovalSeq     []string
}

const maxPendingFrames = 5000

func NewLiveState(taskID string) *LiveState {
	return &LiveState{
		TaskID:     taskID,
		Tracker:    NewTaskTracker(),
		Approvals:  make(map[string]Approval),
		KindCounts: make(map[string]int),
		eventNames: make(map[string]int),
	}
}

// SetTaskID names the acceptance task and replays frames buffered before the
// task id was known. The replay happens under the same lock as the pump, so a
// frame can never slip between naming the task and replaying the buffer.
func (s *LiveState) SetTaskID(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.TaskID = id
	pending := s.pending
	s.pending = nil
	for _, ev := range pending {
		s.applyLocked(ev)
	}
}

// ApplyFrame decodes one SSE frame carrying a WSMessage. The frame's event
// name and the message's kind are both recorded; a mismatch is counted as an
// unknown shape rather than trusted.
func (s *LiveState) ApplyFrame(ev SSEEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applyLocked(ev)
}

func (s *LiveState) applyLocked(ev SSEEvent) {
	if s.TaskID == "" {
		if len(s.pending) < maxPendingFrames {
			s.pending = append(s.pending, ev)
		} else {
			s.droppedPending++
		}
		return
	}
	s.Frames++
	s.eventNames[ev.Name]++

	var msg wsMessage
	if err := json.Unmarshal([]byte(ev.Data), &msg); err != nil || msg.Kind == "" {
		s.Unknown++
		return
	}
	s.KindCounts[msg.Kind]++
	if msg.Kind != ev.Name {
		s.Unknown++
	}

	switch msg.Kind {
	case "task_update":
		var task Task
		if err := json.Unmarshal(msg.Data, &task); err != nil {
			s.Unknown++
			return
		}
		if task.ID == s.TaskID {
			s.TaskFrames++
			s.Tracker.ApplyTask(task)
		}
	case "task_deleted":
		// Not applied: the durable feed owns deletion, and the acceptance
		// task is deleted only after the recorded run.
		var deleted struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(msg.Data, &deleted); err == nil && deleted.ID == s.TaskID {
			s.TaskFrames++
		}
	case "event":
		var event TaskEvent
		if err := json.Unmarshal(msg.Data, &event); err != nil {
			s.Unknown++
			return
		}
		if event.TaskID == s.TaskID {
			s.TaskFrames++
			s.Tracker.ApplyEvent(event)
		}
	case "approval_update":
		var approval Approval
		if err := json.Unmarshal(msg.Data, &approval); err != nil {
			s.Unknown++
			return
		}
		if approval.TaskID == s.TaskID {
			s.TaskFrames++
			if _, seen := s.Approvals[approval.ID]; !seen {
				s.ApprovalSeq = append(s.ApprovalSeq, approval.ID)
			}
			s.Approvals[approval.ID] = approval
		}
	case "user_question_update":
		// Tracked as a kind only; the acceptance does not answer questions.
		var question struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(msg.Data, &question); err == nil && question.TaskID == s.TaskID {
			s.TaskFrames++
		}
	default:
		s.Unknown++
	}
}

func (s *LiveState) NoteComment() {
	s.mu.Lock()
	s.Comments++
	s.mu.Unlock()
}

// SetStreamErr records an unexpected stream end. A clean EOF is a failure
// unless the client itself asked to close the connection: the acceptance
// stream must stay open for the whole connected phase.
func (s *LiveState) SetStreamErr(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ignoreStreamErr {
		return
	}
	if s.StreamErr == nil && err != nil {
		s.StreamErr = err
	}
}

// IntentionalClose marks the next stream error as the client closing the
// connection, not a daemon failure.
func (s *LiveState) IntentionalClose() {
	s.mu.Lock()
	s.ignoreStreamErr = true
	s.mu.Unlock()
}

// Snapshot returns a consistent copy of the fields the driver inspects.
type LiveSnapshot struct {
	Frames         int
	TaskFrames     int
	Comments       int
	Unknown        int
	DroppedPending int
	KindCounts     map[string]int
	HasTask        bool
	Task           Task
	Epoch          int64
	HaveEpoch      bool
	NextSeq        int64
	EventCount     int
	Events         map[EventKey]TaskEvent
	Order          []EventKey
	Gaps           []string
	PartialChunks  int
	FinalText      string
	HaveFinal      bool
	Approvals      map[string]Approval
	ApprovalIDs    []string
	StreamErr      error
	EventNameCount map[string]int
}

func (s *LiveState) Snapshot() LiveSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	events := make(map[EventKey]TaskEvent, len(s.Tracker.Events))
	for k, v := range s.Tracker.Events {
		events[k] = v
	}
	approvals := make(map[string]Approval, len(s.Approvals))
	for k, v := range s.Approvals {
		approvals[k] = v
	}
	kinds := make(map[string]int, len(s.KindCounts))
	for k, v := range s.KindCounts {
		kinds[k] = v
	}
	names := make(map[string]int, len(s.eventNames))
	for k, v := range s.eventNames {
		names[k] = v
	}
	order := make([]EventKey, len(s.Tracker.Order))
	copy(order, s.Tracker.Order)
	gaps := make([]string, len(s.Tracker.Gaps))
	copy(gaps, s.Tracker.Gaps)
	ids := make([]string, len(s.ApprovalSeq))
	copy(ids, s.ApprovalSeq)
	return LiveSnapshot{
		Frames:         s.Frames,
		TaskFrames:     s.TaskFrames,
		Comments:       s.Comments,
		Unknown:        s.Unknown,
		DroppedPending: s.droppedPending,
		KindCounts:     kinds,
		HasTask:        s.Tracker.HasTask,
		Task:           s.Tracker.Task,
		Epoch:          s.Tracker.Epoch,
		HaveEpoch:      s.Tracker.HaveEpoch,
		NextSeq:        s.Tracker.NextSeq,
		EventCount:     len(s.Tracker.Events),
		Events:         events,
		Order:          order,
		Gaps:           gaps,
		PartialChunks:  s.Tracker.Messages.PartialChunks,
		FinalText:      s.Tracker.Messages.FinalText,
		HaveFinal:      s.Tracker.Messages.HaveFinal,
		Approvals:      approvals,
		ApprovalIDs:    ids,
		StreamErr:      s.StreamErr,
		EventNameCount: names,
	}
}

// Pump reads an EventStream into a LiveState until the stream closes.
type Pump struct {
	stream *EventStream
	done   chan struct{}
}

func StartPump(stream *EventStream, state *LiveState) *Pump {
	stream.OnComment = state.NoteComment
	p := &Pump{stream: stream, done: make(chan struct{})}
	go func() {
		defer close(p.done)
		err := stream.Read(func(ev SSEEvent) error {
			state.ApplyFrame(ev)
			return nil
		})
		state.SetStreamErr(err)
	}()
	return p
}

func (p *Pump) Close() {
	if p == nil {
		return
	}
	_ = p.stream.Close()
	<-p.done
}
