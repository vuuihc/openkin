package acp

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/adaptertest"
)

// The mapping from `session/update` to Kin events is the whole surface of an
// ACP turn: everything a person sees while the agent works arrives through
// here. These tests pin the shape of each kind the protocol defines, including
// the ones this client deliberately renders as raw output.

func payloadOf(t *testing.T, event adapter.Event) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(event.Payload, &out); err != nil {
		t.Fatalf("event %s payload is not an object: %v (%s)", event.Type, err, event.Payload)
	}
	return out
}

// mapOne is mapUpdate for the updates that produce at most one event.
func mapOne(t *testing.T, update string) adapter.Event {
	t.Helper()
	events := mapUpdate(json.RawMessage(update))
	if len(events) != 1 {
		t.Fatalf("update %s produced %d events, want 1", update, len(events))
	}
	return events[0]
}

func TestStreamedContentMapsToMessages(t *testing.T) {
	for _, tc := range []struct {
		name      string
		update    string
		wantRole  string
		wantPhase string
	}{
		{
			name:     "the prompt echoed back",
			update:   `{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}`,
			wantRole: "user",
		},
		{
			name:     "the agent talking",
			update:   `{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"},"messageId":"m1"}`,
			wantRole: "assistant",
		},
		{
			name:      "the agent thinking",
			update:    `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}`,
			wantRole:  messageRoleReasoning,
			wantPhase: messagePhaseProgress,
		},
		{
			name:      "a compaction summary",
			update:    `{"sessionUpdate":"compaction_summary_chunk","content":{"type":"text","text":"summary"}}`,
			wantRole:  "assistant",
			wantPhase: messagePhaseCompaction,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := mapOne(t, tc.update)
			if event.Type != "message" {
				t.Fatalf("event type = %q, want message", event.Type)
			}
			payload := payloadOf(t, event)
			if payload["role"] != tc.wantRole {
				t.Fatalf("role = %v, want %s", payload["role"], tc.wantRole)
			}
			if payload["partial"] != true {
				t.Fatalf("a streamed chunk is a partial message: %v", payload)
			}
			phase, _ := payload["phase"].(string)
			if phase != tc.wantPhase {
				t.Fatalf("phase = %q, want %q", phase, tc.wantPhase)
			}
			// The text has to be inside a content block: that is where the console
			// reads it from, and a flat `text` renders as an empty message.
			content, ok := payload["content"].([]any)
			if !ok || len(content) != 1 {
				t.Fatalf("content = %v, want one text block", payload["content"])
			}
			block, _ := content[0].(map[string]any)
			if block["type"] != "text" || strings.TrimSpace(block["text"].(string)) == "" {
				t.Fatalf("content block = %v", content[0])
			}
		})
	}
}

// TestContentThisConsoleCannotDrawIsStillRecorded: an image or an audio clip
// arriving as a chunk used to be nothing at all in the transcript, which reads
// as a missing answer rather than a picture nobody can open.
func TestContentThisConsoleCannotDrawIsStillRecorded(t *testing.T) {
	for _, update := range []string{
		`{"sessionUpdate":"agent_message_chunk","content":{"type":"image","mimeType":"image/png","data":"aGk="}}`,
		`{"sessionUpdate":"user_message_chunk","content":{"type":"audio","mimeType":"audio/wav","data":"aGk="}}`,
		`{"sessionUpdate":"agent_message_chunk","content":{"type":"resource_link","uri":"file:///tmp/x"}}`,
	} {
		event := mapOne(t, update)
		if event.Type != "raw_output" {
			t.Fatalf("update %s produced %q, want raw_output", update, event.Type)
		}
		payload := payloadOf(t, event)
		if payload["stream"] != rawOutputStreamName {
			t.Fatalf("stream = %v, want %s", payload["stream"], rawOutputStreamName)
		}
		if line, _ := payload["line"].(string); !strings.Contains(line, "sessionUpdate") {
			t.Fatalf("the recorded line lost the update it stands for: %v", payload)
		}
	}
}

func TestToolCallsMapToStepsTheConsoleMerges(t *testing.T) {
	t.Run("a call with no output yet", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read file",
			"kind":"read","status":"pending","rawInput":{"path":"/tmp/x"},
			"locations":[{"path":"/tmp/x"}]}`)
		if event.Type != "tool_use" {
			t.Fatalf("event type = %q, want tool_use", event.Type)
		}
		payload := payloadOf(t, event)
		if payload["tool_use_id"] != "t1" || payload["name"] != "Read file" || payload["summary"] != "Read file" {
			t.Fatalf("payload = %v", payload)
		}
		if payload["path"] != "/tmp/x" {
			t.Fatalf("the location the agent reported is how the console knows the file: %v", payload)
		}
		input, ok := payload["input"].(map[string]any)
		if !ok || input["path"] != "/tmp/x" {
			t.Fatalf("input = %v", payload["input"])
		}
	})

	t.Run("a call that arrives with its output", func(t *testing.T) {
		events := mapUpdate(json.RawMessage(`{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run",
			"status":"completed","content":[{"type":"content","content":{"type":"text","text":"exit 0"}}]}`))
		if len(events) != 2 || events[0].Type != "tool_use" || events[1].Type != "tool_result" {
			t.Fatalf("events = %v", eventTypesOf(events))
		}
		result := payloadOf(t, events[1])
		if result["output"] != "exit 0" || result["ok"] != true || result["tool_use_id"] != "t1" {
			t.Fatalf("tool_result = %v", result)
		}
	})

	t.Run("a failed call closes the step as failed", func(t *testing.T) {
		events := mapUpdate(json.RawMessage(`{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run",
			"status":"failed","content":[{"type":"content","content":{"type":"text","text":"boom"}}]}`))
		result := payloadOf(t, events[len(events)-1])
		if result["ok"] != false {
			t.Fatalf("a failed tool call reported ok: %v", result)
		}
	})

	t.Run("a patch that closes the step", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed",
			"content":[{"type":"content","content":{"type":"text","text":"done"}}]}`)
		if event.Type != "tool_result" {
			t.Fatalf("event type = %q, want tool_result", event.Type)
		}
		payload := payloadOf(t, event)
		if payload["output"] != "done" || payload["ok"] != true {
			t.Fatalf("payload = %v", payload)
		}
	})

	t.Run("a patch that is only progress", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"tool_call_update","toolCallId":"t1","title":"Run","status":"in_progress"}`)
		if event.Type != "tool_use" {
			t.Fatalf("event type = %q, want tool_use", event.Type)
		}
		if payload := payloadOf(t, event); payload["status"] != "in_progress" {
			t.Fatalf("payload = %v", payload)
		}
	})

	t.Run("a patch of a call this client never saw", func(t *testing.T) {
		// Still a step: the id is what the console merges on, and dropping it
		// would leave the later result without anything to close.
		event := mapOne(t, `{"sessionUpdate":"tool_call_update","toolCallId":"t9","status":"pending"}`)
		if event.Type != "tool_use" {
			t.Fatalf("event type = %q, want tool_use", event.Type)
		}
		if payload := payloadOf(t, event); payload["tool_use_id"] != "t9" {
			t.Fatalf("payload = %v", payload)
		}
	})

	t.Run("a diff is rendered as text", func(t *testing.T) {
		events := mapUpdate(json.RawMessage(`{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Edit",
			"status":"completed","content":[{"type":"diff","path":"/tmp/x","oldText":"a\n","newText":"b\n"}]}`))
		output, _ := payloadOf(t, events[1])["output"].(string)
		for _, want := range []string{"--- /tmp/x", "+++ /tmp/x", "a", "b"} {
			if !strings.Contains(output, want) {
				t.Fatalf("diff output %q is missing %q", output, want)
			}
		}
	})

	t.Run("a call with no id is raw output", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"tool_call","title":"Nameless"}`)
		if event.Type != "raw_output" {
			t.Fatalf("event type = %q, want raw_output", event.Type)
		}
	})

	t.Run("output is bounded", func(t *testing.T) {
		huge := strings.Repeat("x", maxToolOutputBytes+1024)
		events := mapUpdate(json.RawMessage(`{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run",
			"status":"completed","content":[{"type":"content","content":{"type":"text","text":"` + huge + `"}}]}`))
		output, _ := payloadOf(t, events[1])["output"].(string)
		if len(output) > maxToolOutputBytes+4 {
			t.Fatalf("tool output was not bounded: %d bytes", len(output))
		}
	})
}

func TestPlansReplaceRatherThanAppend(t *testing.T) {
	event := mapOne(t, `{"sessionUpdate":"plan","entries":[
		{"content":"first","status":"pending","priority":"high"},
		{"content":"second","status":"completed","priority":"low"}]}`)
	if event.Type != "plan" {
		t.Fatalf("event type = %q, want plan", event.Type)
	}
	payload := payloadOf(t, event)
	if payload["replaces"] != true {
		// The update carries a whole `Plan` (the schema's `plan` variant is a
		// $ref to it), so it is the current plan, not a revision of one. The
		// console rewrites its single plan line on this flag.
		t.Fatalf("a plan update did not say it replaces the plan: %v", payload)
	}
	entries, _ := payload["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("entries = %v", payload["entries"])
	}
}

// TestAUsageReportWithOnlyCacheNumbersIsStillReported pins the guard behind the
// status line to the line's own contents: the payload carries the cache fields,
// so a report whose only numbers are cache reads has something to show and must
// not be dropped as empty.
func TestAUsageReportWithOnlyCacheNumbersIsStillReported(t *testing.T) {
	for _, tc := range []struct {
		name    string
		usage   *promptUsage
		reportd bool
	}{
		{name: "no usage at all", usage: nil},
		{name: "all zeroes", usage: &promptUsage{}},
		{
			name:    "cache reads only",
			usage:   &promptUsage{CachedReadTokens: intPtr(1200)},
			reportd: true,
		},
		{
			name:    "cache writes only",
			usage:   &promptUsage{CachedWriteTokens: intPtr(300)},
			reportd: true,
		},
		{
			name:    "reasoning only",
			usage:   &promptUsage{ThoughtTokens: intPtr(7)},
			reportd: true,
		},
		{name: "tokens", usage: &promptUsage{InputTokens: 11, OutputTokens: 5}, reportd: true},
		{name: "a total on its own", usage: &promptUsage{TotalTokens: 16}, reportd: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := reportedUsageNotice(tc.usage)
			if !tc.reportd {
				if payload != nil {
					t.Fatalf("an empty report became a status line: %v", payload)
				}
				return
			}
			if payload == nil {
				t.Fatalf("a report was dropped as empty: %+v", tc.usage)
			}
			// Whatever the guard let through has to be in the line, or the line
			// is a status with no status in it.
			message, _ := payload["message"].(string)
			for key, value := range payload {
				if !strings.HasPrefix(key, "reported_") {
					continue
				}
				n, ok := value.(int)
				if !ok {
					t.Fatalf("%s=%v is not a number", key, value)
				}
				if !strings.Contains(message, strconv.Itoa(n)) {
					t.Fatalf("%s=%d is in the payload but not in %q", key, n, message)
				}
			}
		})
	}
}

func intPtr(v int) *int { return &v }

// TestContextUsageIsNotBilling keeps ACP's context-window report from being
// read as a bill: `used` and `size` are occupancy, and the cost that comes with
// them is only passed through in the currency it was reported in.
//
// The split matters for a second reason: a Kin `usage` event goes through the
// engine's accounting, which refuses one with nothing to account for. A report
// of occupancy alone must therefore not be a usage event, or every one of them
// becomes a dropped-event diagnostic.
func TestContextUsageIsNotBilling(t *testing.T) {
	t.Run("occupancy alone is a status line", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"usage_update","used":100,"size":1000}`)
		if event.Type != "notice" {
			t.Fatalf("event type = %q, want notice", event.Type)
		}
		payload := payloadOf(t, event)
		if payload["context_used"] != float64(100) || payload["context_size"] != float64(1000) {
			t.Fatalf("payload = %v", payload)
		}
		if payload["kind"] != updateUsage {
			t.Fatalf("the notice does not say what it is: %v", payload)
		}
		if _, ok := payload["input_tokens"]; ok {
			t.Fatalf("context occupancy was reported as input tokens: %v", payload)
		}
		if _, ok := payload["source"]; ok {
			// `source` is attribution and the engine owns it; a value here would
			// override the agent id (and be read as the provider).
			t.Fatalf("the adapter claimed the attribution field: %v", payload)
		}
	})

	t.Run("usd", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"usage_update","used":100,"size":1000,
			"cost":{"amount":0.25,"currency":"USD"}}`)
		// Not a usage event even in dollars: ACP's cost is the session's running
		// total, and Kin's usage events are incremental. Booking it would both
		// inflate the ledger and take the turn's own tokens with it (a turn that
		// emitted usage is not asked for the tokens on its prompt response).
		if event.Type != "notice" {
			t.Fatalf("event type = %q, want notice", event.Type)
		}
		payload := payloadOf(t, event)
		if payload["context_used"] != float64(100) || payload["context_size"] != float64(1000) {
			t.Fatalf("payload = %v", payload)
		}
		if _, ok := payload["cost_usd"]; ok {
			t.Fatalf("a session's running total was reported as bookable cost: %v", payload)
		}
		if payload["cost_amount"] != 0.25 || payload["cost_scope"] != "session" {
			t.Fatalf("the cost is not reported with its scope: %v", payload)
		}
		if _, ok := payload["input_tokens"]; ok {
			t.Fatalf("context occupancy was reported as input tokens: %v", payload)
		}
	})

	t.Run("another currency", func(t *testing.T) {
		event := mapOne(t, `{"sessionUpdate":"usage_update","used":1,"size":10,
			"cost":{"amount":3,"currency":"CNY"}}`)
		if event.Type != "notice" {
			t.Fatalf("event type = %q, want notice", event.Type)
		}
		payload := payloadOf(t, event)
		if payload["cost_currency"] != "CNY" || payload["cost_amount"] != float64(3) {
			t.Fatalf("the reported cost was dropped: %v", payload)
		}
		if _, ok := payload["cost_usd"]; ok {
			t.Fatalf("an exchange rate was invented: %v", payload)
		}
		if message, _ := payload["message"].(string); !strings.Contains(message, "CNY") {
			t.Fatalf("the status line does not say what it cost: %v", payload)
		}
	})
}

// TestEveryUsageReportIsSomethingTheEngineCanStore is the rule behind the
// mapping above, checked against the engine's own contract: whatever an agent
// reports, what Kin emits is an event the engine can persist and account for.
// `usage` is a critical event there — one it cannot account for fails the turn
// that produced it — so a report whose scope is the session, or one in a
// currency the store cannot hold, must come out as something else.
func TestEveryUsageReportIsSomethingTheEngineCanStore(t *testing.T) {
	for _, update := range []string{
		`{"sessionUpdate":"usage_update","used":1,"size":10}`,
		`{"sessionUpdate":"usage_update","used":1,"size":10,"cost":{"amount":3,"currency":"CNY"}}`,
		`{"sessionUpdate":"usage_update","used":1,"size":10,"cost":{"amount":3,"currency":"usd"}}`,
		`{"sessionUpdate":"usage_update","used":1,"size":10,"cost":{"amount":-1,"currency":"USD"}}`,
	} {
		event := mapOne(t, update)
		if event.Type == "usage" {
			t.Fatalf("a session-scoped report was booked as this turn's usage: %s", event.Payload)
		}
		adaptertest.AssertEvents(t, []adapter.Event{event})
	}
}

func TestStatusUpdatesMapToNotices(t *testing.T) {
	for _, tc := range []struct {
		name         string
		update       string
		wantTitle    string
		wantSeverity string
	}{
		{
			name:      "the agent's command list",
			update:    `{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"web"}]}`,
			wantTitle: "available commands",
		},
		{
			name:      "a mode change",
			update:    `{"sessionUpdate":"current_mode_update","currentModeId":"code"}`,
			wantTitle: "mode changed",
		},
		{
			name:      "a settings change",
			update:    `{"sessionUpdate":"config_option_update","configOptions":[]}`,
			wantTitle: "settings changed",
		},
		{
			name:      "a context compaction",
			update:    `{"sessionUpdate":"compaction_update"}`,
			wantTitle: "context compacted",
		},
		{
			name:      "a notice the agent wrote itself",
			update:    `{"sessionUpdate":"notice","severity":"error","title":"careful","message":"the disk is full"}`,
			wantTitle: "careful",
		},
		{
			name:      "the agent's own name for the session",
			update:    `{"sessionUpdate":"session_info_update","title":"refactor the parser"}`,
			wantTitle: "refactor the parser",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			event := mapOne(t, tc.update)
			if event.Type != "notice" {
				t.Fatalf("event type = %q, want notice", event.Type)
			}
			payload := payloadOf(t, event)
			title, _ := payload["title"].(string)
			message, _ := payload["message"].(string)
			if title != tc.wantTitle && message != tc.wantTitle {
				t.Fatalf("notice neither titled nor says %q: %v", tc.wantTitle, payload)
			}
			if severity, _ := payload["severity"].(string); severity == "" {
				t.Fatalf("notice without a severity: %v", payload)
			}
		})
	}

	t.Run("a severity the agent chose is kept", func(t *testing.T) {
		payload := payloadOf(t, mapOne(t, `{"sessionUpdate":"notice","severity":"error","text":"nope"}`))
		if payload["severity"] != "error" || payload["message"] != "nope" {
			t.Fatalf("payload = %v", payload)
		}
	})

	t.Run("the agent's session title is not a task rename", func(t *testing.T) {
		// `tasks.title` belongs to the prompt; a notice is how the console can
		// show the agent's own name without a second writer on that field.
		payload := payloadOf(t, mapOne(t, `{"sessionUpdate":"session_info_update","title":"named by the agent"}`))
		if payload["message"] != "named by the agent" || payload["kind"] != updateSessionInfo {
			t.Fatalf("payload = %v", payload)
		}
	})
}

// TestUpdatesThisClientDoesNotModelAreTolerated: the protocol requires unknown
// updates to be ignored without error, and an agent that sends one must not
// look like a failed turn.
func TestUpdatesThisClientDoesNotModelAreTolerated(t *testing.T) {
	for _, update := range []string{
		`{"sessionUpdate":"a_kind_from_a_newer_agent","whatever":1}`,
		`{"sessionUpdate":""}`,
		`not json`,
		`{"sessionUpdate":"session_info_update"}`,
		`{"sessionUpdate":"notice"}`,
	} {
		if events := mapUpdate(json.RawMessage(update)); len(events) != 0 {
			t.Fatalf("update %s produced %v, want nothing", update, eventTypesOf(events))
		}
	}

	// An empty plan is a plan: the agent cleared it, and plan updates replace the
	// previous one rather than adding to it.
	events := mapUpdate(json.RawMessage(`{"sessionUpdate":"plan"}`))
	if len(events) != 1 || events[0].Type != "plan" {
		t.Fatalf("an empty plan produced %v", eventTypesOf(events))
	}
	if entries, ok := payloadOf(t, events[0])["entries"].([]any); !ok || len(entries) != 0 {
		t.Fatalf("an empty plan should carry no entries: %s", events[0].Payload)
	}
}

func eventTypesOf(events []adapter.Event) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.Type)
	}
	return types
}
