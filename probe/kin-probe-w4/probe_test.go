package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func testConfig(baseURL string) Config {
	return Config{
		BaseURL:          baseURL,
		MasterToken:      testMasterToken,
		Label:            "probe-w4-test",
		TurnTimeout:      10 * time.Second,
		ReconnectTimeout: 2 * time.Second,
	}
}

func TestRunAcceptanceWithApproval(t *testing.T) {
	fake := newFakeDaemon(t, true)
	fake.seed(5)
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	if len(summary.Steps) != 6 {
		t.Fatalf("steps = %d, want 6", len(summary.Steps))
	}
	for _, step := range summary.Steps {
		if step.Status != "pass" {
			t.Errorf("step %s = %s (%s), want pass", step.Name, step.Status, step.Detail)
		}
	}
	if summary.PeakRSSBytes <= 0 {
		t.Errorf("peak RSS = %d, want > 0", summary.PeakRSSBytes)
	}
	wantObs := map[string]any{
		"marker_in_live_text":         true,
		"marker_in_durable_events":    true,
		"text_frames":                 2,
		"approval_exercised_live":     true,
		"approval_frame_seen":         true,
		"approval_list_ok":            true,
		"approval_rows_for_task":      1,
		"reconnect_frame_seen":        true,
		"snapshot_sessions":           5,
		"create_permission_mode":      "default",
		"terminal_permission_mode":    "default",
		"text_before_terminal":        true,
		"cleanup_device_revoked":      true,
		"cleanup_task_deleted":        true,
		"live_events_missing_durably": 0,
		"live_events_type_mismatch":   0,
	}
	for key, want := range wantObs {
		if got := summary.Observations[key]; got != want {
			t.Errorf("observation %s = %#v, want %#v", key, got, want)
		}
	}
	if types, ok := summary.Observations["marker_live_types"].([]string); !ok || len(types) != 1 || types[0] != "assistant_delta" {
		t.Errorf("marker_live_types = %#v, want [assistant_delta]", summary.Observations["marker_live_types"])
	}
	if unseen, ok := summary.Observations["durable_events_unseen_live"].([]string); !ok || len(unseen) != 0 {
		t.Errorf("durable_events_unseen_live = %#v, want none", summary.Observations["durable_events_unseen_live"])
	}
	for _, finding := range summary.Findings {
		if strings.Contains(finding, "next_cursor did not advance") {
			t.Errorf("healthy feed produced a stuck-cursor finding: %s", finding)
		}
	}
	if pages, ok := summary.Observations["snapshot_pages"].(int); !ok || pages < 2 {
		t.Errorf("snapshot pages = %#v, want >= 2 (pagination exercised)", summary.Observations["snapshot_pages"])
	}
	if pages, ok := summary.Observations["catchup_pages"].(int); !ok || pages < 1 {
		t.Errorf("catch-up pages = %#v, want >= 1", summary.Observations["catchup_pages"])
	}
	fake.mu.Lock()
	limits := append([]int(nil), fake.limits...)
	fake.mu.Unlock()
	if mismatches, ok := summary.Observations["catchup_mismatches"].([]string); !ok {
		t.Errorf("catchup_mismatches observation missing (%#v)", summary.Observations["catchup_mismatches"])
	} else if len(mismatches) != 0 {
		t.Errorf("catch-up mismatches: %v", mismatches)
	}
	if len(limits) == 0 {
		t.Error("the fake daemon saw no /api/sessions pages")
	}
	for _, limit := range limits {
		if limit != 500 {
			t.Errorf("feed page requested limit %d, want the documented probe page size 500", limit)
		}
	}

	// ADR 0024: open the stream before draining the feed, on the first snapshot
	// and again after reconnecting.
	log := fake.requestLog()
	firstSSE, firstFeed := firstIndex(log, "sse"), firstIndex(log, "feed")
	if firstSSE < 0 || firstFeed < 0 || firstSSE > firstFeed {
		t.Errorf("ADR 0024 order violated on the first snapshot: requests = %v", log)
	}
	// The disconnect boundary is recorded by the server when the client closes
	// the first subscription. The first catch-up page must come after the new
	// subscription, not before it.
	closeIdx := firstIndex(log, "sse_close")
	if closeIdx < 0 {
		t.Fatalf("no subscription close recorded: %v", log)
	}
	secondSSE := indexAfter(log, "sse", closeIdx)
	feedAfterClose := indexAfter(log, "feed", closeIdx)
	if feedAfterClose < 0 {
		t.Errorf("no catch-up feed page after the disconnect: %v", log)
	} else if secondSSE < 0 || secondSSE > feedAfterClose {
		t.Errorf("reconnect drained before resubscribing (ADR 0024): %v", log)
	}

	fake.mu.Lock()
	revokes := fake.revokes
	for id, task := range fake.tasks {
		if strings.HasPrefix(task.Title, "probe-w4-test") {
			t.Errorf("probe session %s survived cleanup", id)
		}
	}
	fake.mu.Unlock()
	if revokes != 1 {
		t.Errorf("device revokes = %d, want 1 during cleanup", revokes)
	}
}

func TestRunSkipsApprovalWithoutAgentRequest(t *testing.T) {
	fake := newFakeDaemon(t, false)
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	if len(summary.Steps) != 6 {
		t.Fatalf("steps = %d, want 6", len(summary.Steps))
	}
	for _, step := range summary.Steps {
		switch step.Name {
		case "5_approval":
			if step.Status != "skip" {
				t.Errorf("step %s = %s, want skip", step.Name, step.Status)
			}
			for _, want := range []string{"printf probe-w4-tool", "allow-yolo"} {
				if !strings.Contains(step.Detail, want) {
					t.Errorf("skip reason does not name %q: %q", want, step.Detail)
				}
			}
		default:
			if step.Status != "pass" {
				t.Errorf("step %s = %s (%s), want pass", step.Name, step.Status, step.Detail)
			}
		}
	}
	if got := summary.Observations["approval_exercised_live"]; got != false {
		t.Errorf("approval_exercised_live = %#v, want false", got)
	}
	if got := summary.Observations["approval_frame_seen"]; got != false {
		t.Errorf("approval_frame_seen = %#v, want false", got)
	}
	if got := summary.Observations["approval_list_ok"]; got != true {
		t.Errorf("approval_list_ok = %#v, want true: the skip must rest on a readable list", got)
	}
	if got := summary.Observations["approval_rows_for_task"]; got != 0 {
		t.Errorf("approval_rows_for_task = %#v, want 0", got)
	}
	// The skip cause is only established if the turn actually invited a tool.
	fake.mu.Lock()
	prompts := append([]string(nil), fake.prompts...)
	fake.mu.Unlock()
	if len(prompts) != 1 || !strings.Contains(prompts[0], "printf probe-w4-tool") {
		t.Errorf("probe prompt did not invite a tool, so the approval skip cause is unproven: %q", prompts)
	}
}

// A reopened stream that never delivers a frame is a failed reconnect, not a
// pass with a note.
func TestReconnectRequiresFrameProof(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.suppressReconnectFrame = true
	cfg := testConfig(fake.server.URL)
	cfg.ReconnectTimeout = 200 * time.Millisecond
	summary := Run(context.Background(), cfg, NewLogger(io.Discard))

	var reconnect *StepResult
	for i := range summary.Steps {
		if summary.Steps[i].Name == "6_reconnect_catchup" {
			reconnect = &summary.Steps[i]
		}
	}
	if reconnect == nil || reconnect.Status != "fail" {
		t.Fatalf("step 6 = %#v, want fail when the reopened stream stays silent", reconnect)
	}
	if got := summary.Observations["reconnect_frame_seen"]; got != false {
		t.Errorf("reconnect_frame_seen = %#v, want false", got)
	}
}

// An echoed prompt contains the marker. It must not satisfy the streaming
// check on its own.
func TestStepPromptRejectsPromptEcho(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.userEchoOnly = true
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	var prompt *StepResult
	for i := range summary.Steps {
		if summary.Steps[i].Name == "4_prompt_stream" {
			prompt = &summary.Steps[i]
		}
	}
	if prompt == nil || prompt.Status != "fail" {
		t.Fatalf("step 4 = %#v, want fail when only the prompt echo carries the marker", prompt)
	}
	if got := summary.Observations["marker_in_live_text"]; got != false {
		t.Errorf("marker_in_live_text = %#v, want false", got)
	}
	if got := summary.Observations["text_frames"]; got != 0 {
		t.Errorf("text_frames = %#v, want 0", got)
	}
	if got := summary.Observations["marker_in_durable_events"]; got != false {
		t.Errorf("marker_in_durable_events = %#v, want false: the durable prompt echo must be filtered too", got)
	}
}

// The durable log is a recovery path, not a substitute for live delivery: the
// step is "see streaming text", so a marker that appears only durably fails it.
func TestStepPromptRequiresLiveMarker(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.markerDurableOnly = true
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	var prompt *StepResult
	for i := range summary.Steps {
		if summary.Steps[i].Name == "4_prompt_stream" {
			prompt = &summary.Steps[i]
		}
	}
	if prompt == nil || prompt.Status != "fail" {
		t.Fatalf("step 4 = %#v, want fail when the marker is durable but not live", prompt)
	}
	if !strings.Contains(prompt.Detail, "durable log") {
		t.Errorf("failure does not name the durable-only marker: %q", prompt.Detail)
	}
	if got := summary.Observations["marker_in_live_text"]; got != false {
		t.Errorf("marker_in_live_text = %#v, want false", got)
	}
	if got := summary.Observations["marker_in_durable_events"]; got != true {
		t.Errorf("marker_in_durable_events = %#v, want true", got)
	}
}

// A durable row that never arrived live must be named, so the report can say
// what the stream lost instead of only how many rows it lost.
func TestDurableUnseenLiveReported(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.echoDurableOnly = true
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	for _, step := range summary.Steps {
		if step.Status == "fail" {
			t.Fatalf("step %s failed: %s", step.Name, step.Detail)
		}
	}
	unseen, ok := summary.Observations["durable_events_unseen_live"].([]string)
	if !ok || len(unseen) != 1 {
		t.Fatalf("durable_events_unseen_live = %#v, want one row", summary.Observations["durable_events_unseen_live"])
	}
	if parts := strings.Split(unseen[0], ":"); len(parts) != 3 || parts[2] != "user_message" {
		t.Fatalf("unseen row = %q, want epoch:seq:type naming user_message", unseen[0])
	}
}

// The daemon may echo the prompt in more than one fragment. The marker is
// still prompt text and must not satisfy the assistant-text check.
func TestStepPromptRejectsSplitPromptEcho(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.splitEcho = true
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	var prompt *StepResult
	for i := range summary.Steps {
		if summary.Steps[i].Name == "4_prompt_stream" {
			prompt = &summary.Steps[i]
		}
	}
	if prompt == nil || prompt.Status != "fail" {
		t.Fatalf("step 4 = %#v, want fail when a split prompt echo is the only marker carrier", prompt)
	}
	if got := summary.Observations["marker_in_live_text"]; got != false {
		t.Errorf("marker_in_live_text = %#v, want false", got)
	}
	if types, ok := summary.Observations["marker_live_types"].([]string); !ok || len(types) != 0 {
		t.Errorf("marker_live_types = %#v, want none", summary.Observations["marker_live_types"])
	}
	if got := summary.Observations["marker_in_durable_events"]; got != false {
		t.Errorf("marker_in_durable_events = %#v, want false", got)
	}
}

// An approval only counts when the daemon's response records the decision.
func TestApprovalRequiresApprovedResponse(t *testing.T) {
	fake := newFakeDaemon(t, true)
	fake.ignoreDecision = true
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	var approval *StepResult
	for i := range summary.Steps {
		if summary.Steps[i].Name == "5_approval" {
			approval = &summary.Steps[i]
		}
	}
	if approval == nil || approval.Status != "fail" {
		t.Fatalf("step 5 = %#v, want fail when the decision does not read back as approved", approval)
	}
}

// "No approval appeared" is only assertable when the list was readable.
func TestApprovalAbsenceRequiresReadableList(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.approvalListFails = true
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))

	var approval *StepResult
	for i := range summary.Steps {
		if summary.Steps[i].Name == "5_approval" {
			approval = &summary.Steps[i]
		}
	}
	if approval == nil || approval.Status != "fail" {
		t.Fatalf("step 5 = %#v, want fail when /api/approvals is unreadable", approval)
	}
	if !strings.Contains(approval.Detail, "/api/approvals") {
		t.Errorf("failure does not name the unreadable list: %q", approval.Detail)
	}
}

func firstIndex(log []string, want string) int {
	for i, entry := range log {
		if entry == want {
			return i
		}
	}
	return -1
}

func indexAfter(log []string, want string, after int) int {
	for i := after + 1; i < len(log); i++ {
		if log[i] == want {
			return i
		}
	}
	return -1
}

func TestHandleFrameKeepsEpochsApart(t *testing.T) {
	p := &probe{
		taskID:         "task-1",
		liveEvents:     map[eventKey]TaskEvent{},
		eventTypes:     map[string]int{},
		taskEventTypes: map[string]int{},
		textEventTypes: map[string]int{},
		taskStatuses:   map[string]bool{},
	}
	frame := func(epoch, seq int64, typ string) SSEEvent {
		data, err := json.Marshal(TaskEvent{TaskID: "task-1", EventEpoch: epoch, Seq: seq, Type: typ, Payload: json.RawMessage(`{}`)})
		if err != nil {
			t.Fatal(err)
		}
		msg, err := json.Marshal(WSMessage{Kind: "event", Data: data})
		if err != nil {
			t.Fatal(err)
		}
		return SSEEvent{Event: "event", Data: msg}
	}
	p.handleFrame(frame(1, 1, "message"), time.Now())
	p.handleFrame(frame(2, 1, "result"), time.Now())
	if len(p.liveEvents) != 2 {
		t.Fatalf("live events = %d, want 2: seq is only unique within an epoch", len(p.liveEvents))
	}
	if got := p.liveEvents[eventKey{Epoch: 2, Seq: 1}].Type; got != "result" {
		t.Fatalf("epoch 2 seq 1 type = %q, want result", got)
	}
}

func TestDurableIndexKeepsEpochsApart(t *testing.T) {
	idx := durableIndex([]TaskEvent{
		{TaskID: "t", EventEpoch: 1, Seq: 1, Type: "message"},
		{TaskID: "t", EventEpoch: 2, Seq: 1, Type: "result"},
	})
	if len(idx) != 2 {
		t.Fatalf("durable index has %d entries, want 2: seq is only unique within an epoch", len(idx))
	}
	if got := idx[eventKey{Epoch: 2, Seq: 1}].Type; got != "result" {
		t.Fatalf("epoch 2 seq 1 type = %q, want result", got)
	}
}

func TestSnapshotStopsOnStuckFeedCursor(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.seed(5)
	fake.stuckCursor = true
	p := &probe{
		cfg:    testConfig(fake.server.URL),
		log:    NewLogger(io.Discard),
		sum:    &Summary{Observations: map[string]any{}},
		client: NewClient(fake.server.URL, testDeviceToken),
	}
	defer p.closeStream()
	if _, err := p.stepSnapshot(context.Background()); err != nil {
		t.Fatalf("stepSnapshot: %v", err)
	}
	if pages := p.sum.Observations["snapshot_pages"]; pages != 1 {
		t.Errorf("snapshot pages = %#v, want 1 before the guard stops the walk", pages)
	}
	if sessions := p.sum.Observations["snapshot_sessions"]; sessions != 2 {
		t.Errorf("snapshot sessions = %#v, want the 2 sessions of the first page", sessions)
	}
	found := false
	for _, finding := range p.sum.Findings {
		if strings.Contains(finding, "next_cursor did not advance") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no stuck-cursor finding; findings = %v", p.sum.Findings)
	}
}

func TestSnapshotCompleteAtPageCapHasNoFinding(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.pageSize = 2
	fake.seed(200) // exactly 100 pages
	p := &probe{
		cfg:    testConfig(fake.server.URL),
		log:    NewLogger(io.Discard),
		sum:    &Summary{Observations: map[string]any{}},
		client: NewClient(fake.server.URL, testDeviceToken),
	}
	defer p.closeStream()
	if _, err := p.stepSnapshot(context.Background()); err != nil {
		t.Fatalf("stepSnapshot: %v", err)
	}
	if pages := p.sum.Observations["snapshot_pages"]; pages != 100 {
		t.Errorf("snapshot pages = %#v, want 100", pages)
	}
	for _, finding := range p.sum.Findings {
		if strings.Contains(finding, "100-page cap") {
			t.Errorf("a complete feed at the page cap produced a finding: %s", finding)
		}
	}
}

func TestSnapshotCapEmitsFindingWhenMoreRemains(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.pageSize = 2
	fake.seed(202) // the walk stops at 100 pages with rows still pending
	p := &probe{
		cfg:    testConfig(fake.server.URL),
		log:    NewLogger(io.Discard),
		sum:    &Summary{Observations: map[string]any{}},
		client: NewClient(fake.server.URL, testDeviceToken),
	}
	defer p.closeStream()
	if _, err := p.stepSnapshot(context.Background()); err != nil {
		t.Fatalf("stepSnapshot: %v", err)
	}
	found := false
	for _, finding := range p.sum.Findings {
		if strings.Contains(finding, "100-page cap") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no page-cap finding while rows remain; findings = %v", p.sum.Findings)
	}
}

func TestStartStreamReplacesPrevious(t *testing.T) {
	fake := newFakeDaemon(t, false)
	p := &probe{
		cfg:    testConfig(fake.server.URL),
		log:    NewLogger(io.Discard),
		sum:    &Summary{Observations: map[string]any{}},
		client: NewClient(fake.server.URL, testDeviceToken),
	}
	defer p.closeStream()
	if _, err := p.startStream(context.Background()); err != nil {
		t.Fatalf("first subscription: %v", err)
	}
	first := p.stream
	// Close the replaced stream even if the implementation under test did not;
	// otherwise the stub server's handler would outlive the test.
	defer func() { _ = first.Close() }()
	if _, err := p.startStream(context.Background()); err != nil {
		t.Fatalf("second subscription: %v", err)
	}
	if p.stream == first {
		t.Fatal("second subscription reused the first stream")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		fake.mu.Lock()
		subs := len(fake.subs)
		fake.mu.Unlock()
		if subs == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("server still has %d subscribers; the replaced stream was not closed", subs)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCleanupCancelsThenDeletes(t *testing.T) {
	fake := newFakeDaemon(t, false)
	fake.deleteFailures = 1
	summary := Run(context.Background(), testConfig(fake.server.URL), NewLogger(io.Discard))
	if got := summary.Observations["cleanup_task_deleted"]; got != true {
		t.Errorf("cleanup_task_deleted = %#v, want true after the retry", got)
	}

	fake.mu.Lock()
	cancels, deletes, revokes := fake.cancelCalls, fake.deletes, fake.revokes
	var survived []string
	for id, task := range fake.tasks {
		if strings.HasPrefix(task.Title, "probe-w4-test") {
			survived = append(survived, id)
		}
	}
	fake.mu.Unlock()
	if cancels != 1 {
		t.Errorf("cancel calls = %d, want 1 after the refused delete", cancels)
	}
	if deletes != 2 {
		t.Errorf("delete attempts = %d, want 2 (refused, then retried)", deletes)
	}
	if revokes != 1 {
		t.Errorf("device revokes = %d, want 1", revokes)
	}
	if len(survived) != 0 {
		t.Errorf("probe sessions survived cleanup: %v", survived)
	}
}

func TestSSEStreamParsesFrames(t *testing.T) {
	raw := ": ping\n\n" +
		"event: task_update\ndata: {\"kind\":\"task_update\"}\n\n" +
		"data: line1\ndata: line2\n\n" +
		"event: x\ndata:{}\n\n" +
		": ping\n"
	stream := &SSEStream{
		body:    io.NopCloser(strings.NewReader(raw)),
		cancel:  func() {},
		scanner: bufio.NewScanner(strings.NewReader(raw)),
	}
	want := []SSEEvent{
		{Event: "task_update", Data: []byte(`{"kind":"task_update"}`)},
		{Event: "message", Data: []byte("line1\nline2")},
		{Event: "x", Data: []byte("{}")},
	}
	for i, wantEvent := range want {
		got, err := stream.Next()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if got.Event != wantEvent.Event || string(got.Data) != string(wantEvent.Data) {
			t.Errorf("frame %d = %q %q, want %q %q", i, got.Event, got.Data, wantEvent.Event, wantEvent.Data)
		}
	}
	if _, err := stream.Next(); err != io.EOF {
		t.Fatalf("after last frame: %v, want EOF", err)
	}
}

func TestTextFragments(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    []string
	}{
		{"delta", `{"delta":"a"}`, []string{"a"}},
		{"nested content", `{"message":{"content":[{"type":"text","text":"b"}]}}`, []string{"b"}},
		{"content string", `{"content":"c"}`, []string{"c"}},
		{"metadata only", `{"id":"x","path":"/y","type":"assistant"}`, nil},
		{"top-level string", `"hello"`, nil},
		{"blank text", `{"text":"  "}`, nil},
		{"invalid", `{`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := textFragments([]byte(tc.payload))
			if len(got) != len(tc.want) {
				t.Fatalf("fragments = %#v, want %#v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("fragments = %#v, want %#v", got, tc.want)
				}
			}
		})
	}
}

func TestCompareTask(t *testing.T) {
	base := Task{ID: "t", Title: "title", Status: "completed", EventEpoch: 2, FinishedAt: 123}
	if got := compareTask(base, base); len(got) != 0 {
		t.Fatalf("identical tasks reported %v", got)
	}
	changed := base
	changed.Status = "running"
	if got := compareTask(base, changed); len(got) != 1 {
		t.Fatalf("status change reported %v, want one mismatch", got)
	}
}

func TestPeakRSS(t *testing.T) {
	if got := peakRSSBytes(); got <= 0 {
		t.Fatalf("peakRSSBytes = %d, want > 0", got)
	}
}
