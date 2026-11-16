package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestObserveFrameKeepsTasksApart is the regression for the cross-task seq
// collision: events.seq restarts at 1 per task, and /api/events is global.
func TestObserveFrameKeepsTasksApart(t *testing.T) {
	r := &runner{
		ev:           &evidence{},
		liveEvents:   map[string]map[int64]observedEvent{},
		liveApproval: map[string]Approval{},
		frameCounts:  map[string]int{},
		taskFrames:   map[string]map[string]int{},
		taskEpoch:    map[string]int64{},
		unknownKinds: map[string]int{},
	}
	frame := func(task string, seq int64, typ string) SSEFrame {
		data, _ := json.Marshal(WSMessage{
			Kind: "event",
			Data: mustJSON(t, TaskEvent{TaskID: task, Seq: seq, Type: typ}),
		})
		return SSEFrame{Event: "event", Data: string(data), At: time.Now()}
	}
	r.observeFrame(frame("task-a", 1, "message"))
	r.observeFrame(frame("task-b", 1, "message"))
	r.observeFrame(frame("task-a", 3, "message"))

	if got := r.liveEventCount("task-a"); got != 2 {
		t.Errorf("task-a events = %d, want 2", got)
	}
	// Frame counts must be task-scoped too: the stream is global, so a global
	// counter could let another session's frames satisfy this task's check.
	if got := r.taskFrameStats("task-a"); got["event"] != 2 {
		t.Errorf("task-a frames = %v, want 2 event frames", got)
	}
	if got := r.taskFrameStats("task-b"); got["event"] != 1 {
		t.Errorf("task-b frames = %v, want 1 event frame", got)
	}
	if got := r.liveEventCount("task-b"); got != 1 {
		t.Errorf("task-b events = %d, want 1", got)
	}
	a := r.liveEventMap("task-a")
	if a[1].TaskID != "task-a" || a[3].TaskID != "task-a" {
		t.Fatalf("task-a map holds another task's frame: %+v", a)
	}
	if b := r.liveEventMap("task-b"); b[1].TaskID != "task-b" {
		t.Fatalf("task-b map holds another task's frame: %+v", b)
	}
	if got := r.maxLiveSeq("task-a"); got != 3 {
		t.Errorf("maxLiveSeq(task-a) = %d, want 3", got)
	}
	if got := r.liveGaps("task-a"); len(got) != 1 || got[0] != 2 {
		t.Errorf("liveGaps(task-a) = %v, want [2]", got)
	}
	if got := r.liveGaps("task-b"); len(got) != 0 {
		t.Errorf("liveGaps(task-b) = %v, want empty", got)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestDrainFeedPaginatesAndAdvances(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		since := req.URL.Query().Get("updated_since")
		seen = append(seen, since)
		switch since {
		case "0":
			json.NewEncoder(w).Encode(SessionPage{NextCursor: 5, HasMore: true})
		case "5":
			json.NewEncoder(w).Encode(SessionPage{NextCursor: 9})
		default:
			t.Errorf("unexpected updated_since=%q", since)
			http.Error(w, "bad cursor", http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test")
	_, _, cursor, pages, err := c.DrainFeed(context.Background(), 0, 0, 0)
	if err != nil {
		t.Fatalf("DrainFeed: %v", err)
	}
	if pages != 2 || cursor != 9 {
		t.Fatalf("pages=%d cursor=%d, want 2 and 9 (requests %v)", pages, cursor, seen)
	}
}

func TestDrainFeedRejectsStalledAndBackwardsCursor(t *testing.T) {
	for name, page := range map[string]SessionPage{
		"stalled":   {NextCursor: 7, HasMore: true},
		"backwards": {NextCursor: 3},
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				json.NewEncoder(w).Encode(page)
			}))
			defer srv.Close()
			c := NewClient(srv.URL, "test")
			_, _, _, _, err := c.DrainFeed(context.Background(), 7, 0, 0)
			if err == nil {
				t.Fatalf("DrainFeed accepted a %s cursor", name)
			}
		})
	}
}

func TestSaveStateIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := saveState(path, &State{Token: "secret", Cursor: 3}); err != nil {
		t.Fatalf("saveState: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("state mode = %o, want 600", mode)
	}
	st, err := loadState(path)
	if err != nil || st.Cursor != 3 {
		t.Fatalf("loadState = %+v, %v", st, err)
	}
}

func TestSaveStateFixesStaleTempMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte("stale"), 0o644); err != nil {
		t.Fatalf("seed temp: %v", err)
	}
	if err := saveState(path, &State{Cursor: 1}); err != nil {
		t.Fatalf("saveState: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("state mode = %o, want 600", mode)
	}
}

func TestWriteEvidenceIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.json")
	if err := writeEvidence(path, &evidence{Tool: "kin-probe"}); err != nil {
		t.Fatalf("writeEvidence: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("evidence mode = %o, want 600", mode)
	}
}

func TestFlagWasSet(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.String("master-token-file", "", "")
	fs.String("state", "", "")
	if flagWasSet(fs, "master-token-file") {
		t.Fatal("flag reported set before Parse")
	}
	if err := fs.Parse([]string{"-master-token-file", "/tmp/token"}); err != nil {
		t.Fatal(err)
	}
	if !flagWasSet(fs, "master-token-file") {
		t.Fatal("flag not reported set after Parse")
	}
	if flagWasSet(fs, "state") {
		t.Fatal("unset flag reported set")
	}
}

// TestObserveFrameConcurrent exercises the SSE observer and finding() together:
// the stream goroutine and the main goroutine both write evidence, so -race
// must stay quiet.
func TestObserveFrameConcurrent(t *testing.T) {
	r := &runner{
		ev:           &evidence{},
		liveEvents:   map[string]map[int64]observedEvent{},
		liveApproval: map[string]Approval{},
		frameCounts:  map[string]int{},
		taskFrames:   map[string]map[string]int{},
		taskEpoch:    map[string]int64{},
		unknownKinds: map[string]int{},
	}
	const tasks, events = 8, 25
	var wg sync.WaitGroup
	for i := 0; i < tasks; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			task := fmt.Sprintf("task-%d", i)
			for seq := int64(1); seq <= events; seq++ {
				payload, err := json.Marshal(TaskEvent{TaskID: task, Seq: seq, Type: "message"})
				if err != nil {
					t.Errorf("marshal event: %v", err) // t.Errorf is safe off the test goroutine
					return
				}
				data, err := json.Marshal(WSMessage{Kind: "event", Data: payload})
				if err != nil {
					t.Errorf("marshal union: %v", err)
					return
				}
				r.observeFrame(SSEFrame{Event: "event", Data: string(data), At: time.Now()})
			}
			r.observeFrame(SSEFrame{Event: "mystery", Data: `{"kind":"mystery","data":{}}`})
		}(i)
	}
	wg.Wait()

	for i := 0; i < tasks; i++ {
		task := fmt.Sprintf("task-%d", i)
		if got := r.liveEventCount(task); got != events {
			t.Errorf("%s events = %d, want %d", task, got, events)
		}
	}
	r.mu.Lock()
	findings := len(r.ev.Findings)
	r.mu.Unlock()
	if findings != 1 {
		t.Errorf("findings = %d, want 1 deduplicated finding", findings)
	}
}

// TestObserveFrameResetsOnEpochChange covers the other half of seq identity:
// seq restarts at 1 when event_epoch bumps, so live state from the old epoch
// must be dropped or a client sees a false gap and stale text.
func TestObserveFrameResetsOnEpochChange(t *testing.T) {
	r := &runner{
		ev:           &evidence{},
		liveEvents:   map[string]map[int64]observedEvent{},
		liveApproval: map[string]Approval{},
		frameCounts:  map[string]int{},
		taskFrames:   map[string]map[string]int{},
		taskEpoch:    map[string]int64{},
		unknownKinds: map[string]int{},
	}
	frame := func(seq, epoch int64) SSEFrame {
		data, _ := json.Marshal(WSMessage{
			Kind: "event",
			Data: mustJSON(t, TaskEvent{TaskID: "task-a", Seq: seq, Type: "message", EventEpoch: epoch}),
		})
		return SSEFrame{Event: "event", Data: string(data), At: time.Now()}
	}
	r.observeFrame(frame(1, 10))
	r.observeFrame(frame(2, 10))
	r.observeFrame(frame(1, 11))

	if got := r.liveEventCount("task-a"); got != 1 {
		t.Errorf("events after epoch change = %d, want 1 (old epoch dropped)", got)
	}
	if live := r.liveEventMap("task-a"); live[1].EventEpoch != 11 {
		t.Errorf("kept event epoch = %d, want 11", live[1].EventEpoch)
	}
	if got := r.epochChangesSnapshot(); len(got) != 1 || !strings.Contains(got[0], "10 -> 11") {
		t.Errorf("epochChanges = %v, want one 10 -> 11 entry", got)
	}
	if got := r.taskFrameStats("task-a"); got["event"] != 3 {
		t.Errorf("task-a frames = %v, want 3 (counts are not reset by an epoch)", got)
	}
}

func TestClearStateForDevice(t *testing.T) {
	st := &State{DeviceID: "ios-a", Token: "tok"}
	clearStateForDevice(st, "ios-b")
	if st.Token != "tok" || st.DeviceID != "ios-a" {
		t.Fatalf("another run's credential was cleared: %+v", st)
	}
	clearStateForDevice(st, "")
	if st.Token != "tok" || st.DeviceID != "ios-a" {
		t.Fatalf("empty device id cleared the credential: %+v", st)
	}
	clearStateForDevice(st, "ios-a")
	if st.Token != "" || st.DeviceID != "" {
		t.Fatalf("own credential not cleared: %+v", st)
	}
}

func TestWaitStreamReady(t *testing.T) {
	r := &runner{ctx: context.Background()}
	if err := r.waitStreamReady(time.Second); err == nil {
		t.Fatal("waitStreamReady succeeded with no stream open")
	}
	r.streamReady = make(chan struct{})
	if err := r.waitStreamReady(20 * time.Millisecond); err == nil {
		t.Fatal("waitStreamReady did not time out")
	}
	r.streamErr = errors.New("stream failed")
	close(r.streamReady)
	if err := r.waitStreamReady(time.Second); err == nil || !strings.Contains(err.Error(), "stream failed") {
		t.Fatalf("waitStreamReady = %v, want the stream error", err)
	}
}

func TestWithTokenDoesNotMutateClient(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", "device-token")
	cp := c.withToken("master-token")
	if c.Token != "device-token" {
		t.Fatalf("base client token mutated to %q", c.Token)
	}
	if cp.Token != "master-token" {
		t.Fatalf("copy token = %q, want master-token", cp.Token)
	}
	if cp.HTTP != c.HTTP || cp.BaseURL != c.BaseURL {
		t.Fatalf("copy did not retain the client transport/config: %+v", cp)
	}
}

// TestObserveFrameRecordsDecodeErrors covers the branches that used to drop a
// malformed payload silently: contract drift in task_update, approval_update,
// or a message payload must fail the run, not vanish.
func TestObserveFrameRecordsDecodeErrors(t *testing.T) {
	r := &runner{
		ev:           &evidence{},
		liveEvents:   map[string]map[int64]observedEvent{},
		liveApproval: map[string]Approval{},
		frameCounts:  map[string]int{},
		taskFrames:   map[string]map[string]int{},
		taskEpoch:    map[string]int64{},
		unknownKinds: map[string]int{},
	}
	r.observeFrame(SSEFrame{Event: "task_update", Data: `{"kind":"task_update","data":{"id":5}}`, At: time.Now()})
	r.observeFrame(SSEFrame{Event: "approval_update", Data: `{"kind":"approval_update","data":{"id":5}}`, At: time.Now()})
	r.observeFrame(SSEFrame{Event: "event", Data: `{"kind":"event","data":{"task_id":"t","seq":1,"type":"message","payload":"not-an-object"}}`, At: time.Now()})
	errs := r.decodeErrorsSnapshot()
	if len(errs) != 3 {
		t.Fatalf("decodeErrors = %v, want 3 entries", errs)
	}
	for i, want := range []string{"task_update", "approval_update", "message"} {
		if !strings.Contains(errs[i], want) {
			t.Errorf("decodeErrors[%d] = %q, want it to name %q", i, errs[i], want)
		}
	}
}

// TestStartStreamRejectsEmptyStream pins the distinction between a live stream
// and a 200 response that closes immediately: the latter must not read as ready.
func TestStartStreamRejectsEmptyStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	r := &runner{ctx: context.Background(), client: NewClient(srv.URL, "token")}
	r.startStream()
	defer r.stopStream()
	err := r.waitStreamReady(time.Second)
	if err == nil || !strings.Contains(err.Error(), "before sending any frame") {
		t.Fatalf("waitStreamReady = %v, want 'closed before sending any frame'", err)
	}
}

func TestStartStreamRecordsCleanClose(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "retry: 3000\n\n")
	}))
	defer srv.Close()
	r := &runner{ctx: context.Background(), client: NewClient(srv.URL, "token")}
	r.startStream()
	r.waitStreamReady(time.Second) // either the frame or the close may win the race
	r.stopStream()
	errs := r.streamErrorsSnapshot()
	if len(errs) == 0 || !strings.Contains(errs[0], "closed by the server") {
		t.Fatalf("streamErrors = %v, want a clean-close error", errs)
	}
}

func TestPendingApprovalReportsQueryError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Error(w, "unavailable", http.StatusInternalServerError)
	}))
	defer srv.Close()
	r := &runner{
		ctx:          context.Background(),
		client:       NewClient(srv.URL, "token"),
		liveApproval: map[string]Approval{},
	}
	a, err := r.pendingApproval("task-a")
	if a != nil || err == nil {
		t.Fatalf("pendingApproval = %+v, %v; want nil, error", a, err)
	}
	// The live frame is still returned, but the caller keeps the query error so
	// it cannot mistake "unreadable" for "no approval".
	r.liveApproval["ap"] = Approval{ID: "ap", TaskID: "task-a"}
	a, err = r.pendingApproval("task-a")
	if a == nil || a.ID != "ap" || err == nil {
		t.Fatalf("pendingApproval with live fallback = %+v, %v; want ap and the query error", a, err)
	}
}

func TestPendingApprovalIgnoresDecidedRows(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// A server ignoring ?status=pending must not hand back a decided row.
		json.NewEncoder(w).Encode([]Approval{{ID: "ap", TaskID: "task-a", Decision: "approved"}})
	}))
	defer srv.Close()
	r := &runner{ctx: context.Background(), client: NewClient(srv.URL, "token"), liveApproval: map[string]Approval{}}
	a, err := r.pendingApproval("task-a")
	if a != nil || err != nil {
		t.Fatalf("pendingApproval = %+v, %v; want nil, nil for a decided row", a, err)
	}
}

func eventsSeqRange(from, to int64) []TaskEvent {
	var out []TaskEvent
	for seq := from; seq <= to; seq++ {
		out = append(out, TaskEvent{Seq: seq, Type: "message"})
	}
	return out
}

// TestDiffCatchupUsesFullTranscriptHorizon is the regression for a truncated
// catch-up defining its own passing horizon: the full transcript is read
// first, so it alone says what catch-up owed the client.
func TestDiffCatchupUsesFullTranscriptHorizon(t *testing.T) {
	full := eventsSeqRange(1, 30)

	healthy := diffCatchup(full, eventsSeqRange(22, 30), 21)
	if healthy.horizon != 30 || len(healthy.expected) != 9 {
		t.Fatalf("healthy diff = horizon %d, expected %d; want 30, 9", healthy.horizon, len(healthy.expected))
	}
	if len(healthy.missing) != 0 || len(healthy.extra) != 0 || len(healthy.problems(21)) != 0 {
		t.Fatalf("healthy diff reported a problem: %+v", healthy)
	}

	truncated := diffCatchup(full, eventsSeqRange(22, 26), 21)
	if truncated.horizon != 30 || len(truncated.expected) != 9 {
		t.Fatalf("truncated diff = horizon %d, expected %d; want 30, 9", truncated.horizon, len(truncated.expected))
	}
	if len(truncated.missing) != 4 || truncated.missing[0] != 27 || truncated.missing[3] != 30 {
		t.Fatalf("truncated missing = %v, want [27 28 29 30]", truncated.missing)
	}
	if len(truncated.problems(21)) == 0 {
		t.Fatal("a catch-up truncated at 26 passed its check")
	}

	// Events appended after the full read are late appends, not failures.
	late := diffCatchup(full, eventsSeqRange(22, 33), 21)
	if len(late.late) != 3 || late.late[0] != 31 || len(late.extra) != 0 || len(late.problems(21)) != 0 {
		t.Fatalf("late appends = %+v, want 31..33 recorded and no problem", late)
	}

	// An event inside the horizon that the full read lacks is a contradiction.
	gappy := append(eventsSeqRange(1, 26), eventsSeqRange(28, 30)...)
	contradiction := diffCatchup(gappy, eventsSeqRange(22, 30), 21)
	if len(contradiction.extra) != 1 || contradiction.extra[0] != 27 {
		t.Fatalf("contradiction extra = %v, want [27]", contradiction.extra)
	}
	if len(contradiction.problems(21)) == 0 {
		t.Fatal("catch-up returned an event the full transcript does not contain, and it passed")
	}

	// Nothing after the live seq means the step has nothing to prove.
	empty := diffCatchup(eventsSeqRange(1, 21), nil, 21)
	if problems := empty.problems(21); len(problems) == 0 || !strings.Contains(problems[0], "nothing to prove") {
		t.Fatalf("empty diff problems = %v, want a nothing-to-prove failure", problems)
	}
}

func TestDecidePermissionGate(t *testing.T) {
	boom := errors.New("boom")
	if v := decidePermissionGate(permissionGate{sweepErr: boom, durableErr: boom}); len(v.errs) == 0 || v.skip || v.bypass {
		t.Errorf("sweep error = %+v, want a failure", v)
	}
	if v := decidePermissionGate(permissionGate{historyRows: 1, durableErr: boom}); !v.skip || v.detail == "" || len(v.errs) != 0 {
		t.Errorf("already-decided history = %+v, want a skip", v)
	}
	if v := decidePermissionGate(permissionGate{errMsg: "turn failed"}); !v.skip || !strings.Contains(v.detail, "failed first") {
		t.Errorf("turn error = %+v, want a failed-first skip", v)
	}
	if v := decidePermissionGate(permissionGate{approvalEvents: 1}); len(v.errs) == 0 || v.skip {
		t.Errorf("approval event with no row = %+v, want a failure", v)
	}
	// Regression: a live tool_use with a failed durable read must not claim a
	// bypass, because the approval event could be in a part of the transcript
	// the live stream missed.
	if v := decidePermissionGate(permissionGate{durableErr: boom, toolUse: true}); len(v.errs) == 0 || v.skip || v.bypass {
		t.Errorf("durable error with live tool_use = %+v, want a failure and no bypass", v)
	}
	if v := decidePermissionGate(permissionGate{toolUse: true, lastStatus: "succeeded"}); !v.skip || !v.bypass || len(v.errs) != 0 {
		t.Errorf("tool use = %+v, want a skip with the bypass finding", v)
	}
	if v := decidePermissionGate(permissionGate{lastStatus: "running"}); !v.skip || !strings.Contains(v.detail, "still running") {
		t.Errorf("running turn = %+v, want a still-running skip", v)
	}
	if v := decidePermissionGate(permissionGate{lastStatus: "succeeded"}); !v.skip || !strings.Contains(v.detail, "without using a tool") {
		t.Errorf("finished idle turn = %+v, want an ended-without-tool skip", v)
	}
}

func TestCountEventTypes(t *testing.T) {
	events := map[int64]TaskEvent{
		1: {Seq: 1, Type: "tool_use"},
		2: {Seq: 2, Type: "approval_requested"},
		5: {Seq: 5, Type: "tool_use"},
	}
	if got := countEventTypes(events, 2, "tool_use"); got != 1 {
		t.Errorf("countEventTypes(since 2) = %d, want 1", got)
	}
	if got := countEventTypes(events, 0, "tool_use", "approval_requested"); got != 3 {
		t.Errorf("countEventTypes(all) = %d, want 3", got)
	}
	durable := eventsBySeq([]TaskEvent{{Seq: 3, Type: "tool_use"}})
	if got := countEventTypes(durable, 0, "tool_use"); got != 1 {
		t.Errorf("countEventTypes(durable) = %d, want 1", got)
	}
}

func TestCollectRunErrors(t *testing.T) {
	r := &runner{
		streamErrors: []string{"SSE stream closed by the server"},
		decodeErrors: []string{"task_update payload: bad"},
		epochChanges: []string{"task-a: 1 -> 2"},
	}
	r.collectRunErrors()
	if len(r.runErrors) != 3 {
		t.Fatalf("runErrors = %v, want 3 entries", r.runErrors)
	}
	for i, want := range []string{"stream:", "decode:", "event_epoch"} {
		if !strings.Contains(r.runErrors[i], want) {
			t.Errorf("runErrors[%d] = %q, want it to mention %q", i, r.runErrors[i], want)
		}
	}
}

func TestPrintSummaryCountsRunErrors(t *testing.T) {
	r := &runner{
		ev:        &evidence{Steps: []*stepResult{{Name: "pair", Status: statusPass}}},
		runErrors: []string{"stream: closed by the server"},
	}
	failed, skipped := r.printSummary()
	if failed != 1 || skipped != 0 {
		t.Fatalf("printSummary = (%d, %d), want (1, 0)", failed, skipped)
	}
}

func TestRunExitCode(t *testing.T) {
	for _, tc := range []struct {
		ok              bool
		failed, skipped int
		want            int
	}{
		{true, 0, 0, 0},
		{true, 0, 1, 3},
		{false, 1, 0, 1},
		{false, 1, 1, 1},
		{false, 0, 0, 1}, // run() failed without a counted step
	} {
		if got := runExitCode(tc.ok, tc.failed, tc.skipped); got != tc.want {
			t.Errorf("runExitCode(%v, %d, %d) = %d, want %d", tc.ok, tc.failed, tc.skipped, got, tc.want)
		}
	}
}
