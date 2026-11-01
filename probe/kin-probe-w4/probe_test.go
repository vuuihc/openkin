package main

import (
	"bufio"
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func testConfig(baseURL string) Config {
	return Config{
		BaseURL:     baseURL,
		MasterToken: testMasterToken,
		Label:       "probe-w4-test",
		TurnTimeout: 10 * time.Second,
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
		"live_events_missing_durably": 0,
		"live_events_type_mismatch":   0,
	}
	for key, want := range wantObs {
		if got := summary.Observations[key]; got != want {
			t.Errorf("observation %s = %#v, want %#v", key, got, want)
		}
	}
	if mismatches, ok := summary.Observations["catchup_mismatches"].([]string); ok && len(mismatches) != 0 {
		t.Errorf("catch-up mismatches: %v", mismatches)
	}
	if pages, ok := summary.Observations["snapshot_pages"].(int); !ok || pages < 2 {
		t.Errorf("snapshot pages = %#v, want >= 2 (pagination exercised)", summary.Observations["snapshot_pages"])
	}
	if pages, ok := summary.Observations["catchup_pages"].(int); !ok || pages < 1 {
		t.Errorf("catch-up pages = %#v, want >= 1", summary.Observations["catchup_pages"])
	}

	// Cleanup must have removed the probe session.
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for id, task := range fake.tasks {
		if strings.HasPrefix(task.Title, "probe-w4-test") {
			t.Errorf("probe session %s survived cleanup", id)
		}
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
			if !strings.Contains(step.Detail, "allow-yolo") {
				t.Errorf("skip reason does not name the cause: %q", step.Detail)
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
