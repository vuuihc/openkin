package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/adaptertest"
)

func TestParseLineGolden(t *testing.T) {
	dir := filepath.Join("testdata")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".input") {
			continue
		}
		base := strings.TrimSuffix(name, ".input")
		t.Run(base, func(t *testing.T) {
			inBytes, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			wantPath := filepath.Join(dir, base+".golden")
			wantBytes, err := os.ReadFile(wantPath)
			if err != nil {
				t.Fatalf("read golden: %v", err)
			}

			type goldenEv struct {
				Type    string `json:"type"`
				Payload any    `json:"payload"`
			}
			var got []goldenEv
			var canonical []adapter.Event
			for _, line := range strings.Split(string(inBytes), "\n") {
				line = strings.TrimRight(line, "\r")
				if line == "" {
					continue
				}
				parsed := ParseLine(line)
				canonical = append(canonical, parsed...)
				for _, ev := range parsed {
					var payload any
					if err := json.Unmarshal(ev.Payload, &payload); err != nil {
						t.Fatalf("payload: %v", err)
					}
					// Drop raw field for stable goldens (full line echo).
					if m, ok := payload.(map[string]any); ok {
						delete(m, "raw")
						payload = m
					}
					got = append(got, goldenEv{Type: ev.Type, Payload: payload})
				}
			}
			adaptertest.AssertEvents(t, canonical)
			gotJSON, err := json.MarshalIndent(got, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			gotJSON = append(gotJSON, '\n')

			if string(gotJSON) != string(wantBytes) {
				t.Errorf("mismatch for %s\n=== got ===\n%s\n=== want ===\n%s",
					base, gotJSON, wantBytes)
				// Write .got for easy update when intentional.
				_ = os.WriteFile(filepath.Join(dir, base+".got"), gotJSON, 0o644)
			}
		})
	}
}

func TestParseLineNeverPanics(t *testing.T) {
	inputs := []string{
		"",
		"not json",
		`{}`,
		`{"type":123}`,
		`{"type":"unknown_xyz","foo":true}`,
		`{"type":"assistant"}`,
		`{"type":"stream_event","event":null}`,
	}
	for _, in := range inputs {
		_ = ParseLine(in)
	}
}

func parseAll(t *testing.T, lines ...string) []adapter.Event {
	t.Helper()
	var events []adapter.Event
	for _, line := range lines {
		events = append(events, ParseLine(line)...)
	}
	return events
}

func eventTypes(events []adapter.Event) []string {
	types := make([]string, 0, len(events))
	for _, ev := range events {
		types = append(types, ev.Type)
	}
	return types
}

func payloadOf(t *testing.T, ev adapter.Event) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		t.Fatalf("payload %s: %v", ev.Payload, err)
	}
	return payload
}

func findEvent(events []adapter.Event, typ string) (adapter.Event, bool) {
	for _, ev := range events {
		if ev.Type == typ {
			return ev, true
		}
	}
	return adapter.Event{}, false
}

// A Claude Code turn reports a tool call in one assistant line and its result
// in a later user line. Both must reach the console as their own events, or a
// finished call keeps breathing until the whole turn ends.
func TestParseMessageToolResultBecomesResultEvent(t *testing.T) {
	events := parseAll(t,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/tmp/repo/README.md"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"# Kin\n"}]}}`,
	)
	if got, want := strings.Join(eventTypes(events), ","), "tool_use,tool_result"; got != want {
		t.Fatalf("event types=%v want=%s", eventTypes(events), want)
	}
	payload := payloadOf(t, events[1])
	if payload["tool_use_id"] != "toolu_01" {
		t.Fatalf("tool_use_id=%v payload=%s", payload["tool_use_id"], events[1].Payload)
	}
	if payload["ok"] != true {
		t.Fatalf("ok=%v payload=%s", payload["ok"], events[1].Payload)
	}
	if payload["output"] != "# Kin\n" {
		t.Fatalf("output=%q payload=%s", payload["output"], events[1].Payload)
	}
	if _, ok := payload["role"]; ok {
		t.Fatalf("tool_result must not carry role: %s", events[1].Payload)
	}
	if _, ok := payload["input"]; ok {
		t.Fatalf("tool_result must not carry input: %s", events[1].Payload)
	}
}

func TestParseMessageToolResultError(t *testing.T) {
	events := parseAll(t,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","is_error":true,"content":"boom"}]}}`,
	)
	if len(events) != 1 || events[0].Type != "tool_result" {
		t.Fatalf("events=%v", eventTypes(events))
	}
	payload := payloadOf(t, events[0])
	if payload["ok"] != false {
		t.Fatalf("ok=%v payload=%s", payload["ok"], events[0].Payload)
	}
	if payload["output"] != "boom" {
		t.Fatalf("output=%q payload=%s", payload["output"], events[0].Payload)
	}
}

func TestParseMessageTextAndToolResultSplit(t *testing.T) {
	events := parseAll(t,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"done"},{"type":"tool_result","tool_use_id":"toolu_03","content":"ok"}]}}`,
	)
	if len(events) != 2 {
		t.Fatalf("events=%v", eventTypes(events))
	}
	msg, ok := findEvent(events, "message")
	if !ok {
		t.Fatalf("missing message event: %v", eventTypes(events))
	}
	result, ok := findEvent(events, "tool_result")
	if !ok {
		t.Fatalf("missing tool_result event: %v", eventTypes(events))
	}
	var content []map[string]any
	payload := payloadOf(t, msg)
	rawContent, _ := json.Marshal(payload["content"])
	if err := json.Unmarshal(rawContent, &content); err != nil {
		t.Fatalf("content %s: %v", rawContent, err)
	}
	if len(content) != 1 || content[0]["type"] != "text" || content[0]["text"] != "done" {
		t.Fatalf("message content=%s", rawContent)
	}
	if payloadOf(t, result)["tool_use_id"] != "toolu_03" {
		t.Fatalf("result payload=%s", result.Payload)
	}
}

func TestParseMessageToolResultOnlyIsNoEmptyMessage(t *testing.T) {
	events := parseAll(t,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_04","content":"ok"},{"type":"tool_result","tool_use_id":"toolu_05","content":"ok"}]}}`,
	)
	if len(events) != 2 || events[0].Type != "tool_result" || events[1].Type != "tool_result" {
		t.Fatalf("events=%v", eventTypes(events))
	}
	if _, ok := findEvent(events, "message"); ok {
		t.Fatalf("a user message of only tool results must not emit an empty message: %v", eventTypes(events))
	}
}

func TestParseMessageToolResultArrayContent(t *testing.T) {
	events := parseAll(t,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_06","content":[{"type":"text","text":"a"},{"type":"image","source":{"data":"AAAA"}},{"type":"text","text":"b"}]}]}}`,
	)
	if len(events) != 1 || events[0].Type != "tool_result" {
		t.Fatalf("events=%v", eventTypes(events))
	}
	payload := payloadOf(t, events[0])
	if payload["output"] != "a\nb" {
		t.Fatalf("output=%q payload=%s", payload["output"], events[0].Payload)
	}
}

func TestParseMessageToolResultOutputTruncated(t *testing.T) {
	long := strings.Repeat("x", 64*1024+100)
	line := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_07","content":"` + long + `"}]}}`
	events := parseAll(t, line)
	if len(events) != 1 || events[0].Type != "tool_result" {
		t.Fatalf("events=%v", eventTypes(events))
	}
	output, _ := payloadOf(t, events[0])["output"].(string)
	if len(output) > 64*1024+len("…") {
		t.Fatalf("output length=%d, want bounded at 64 KiB", len(output))
	}
	if !strings.HasSuffix(output, "…") {
		t.Fatalf("truncated output must end in an ellipsis, tail=%q", output[len(output)-8:])
	}
}

func TestParseRateLimitEventAllowedIsDropped(t *testing.T) {
	line := `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1710000000,"window":"5h"}}`
	if got := ParseLine(line); len(got) != 0 {
		t.Fatalf("expected no events for status=allowed, got=%+v", got)
	}
}

func TestParseRateLimitEvent(t *testing.T) {
	line := `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1710000000,"window":"5h"},"message":"limit"}`
	got := ParseLine(line)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("got=%+v", got)
	}
	var m map[string]any
	if err := json.Unmarshal(got[0].Payload, &m); err != nil {
		t.Fatal(err)
	}
	if m["kind"] != "rate_limited" {
		t.Fatalf("kind=%v payload=%s", m["kind"], string(got[0].Payload))
	}
	if int64(m["reset_at"].(float64)) != 1710000000 {
		t.Fatalf("reset_at=%v", m["reset_at"])
	}
}
