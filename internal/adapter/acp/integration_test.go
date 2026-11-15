package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

// These tests drive the adapter against a fake ACP agent process over real
// pipes. The protocol's shape only exists at that boundary — a handshake, a
// session, a prompt, and a question asked in the middle of one — and the
// failure this file exists to catch is a client that looks right in pieces and
// leaves an agent waiting on a pipe.

// loggedMessage is one line the fake agent read or wrote, decoded enough to ask
// what it was.
type loggedMessage struct {
	raw    string
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
}

func (m loggedMessage) methodOf(t *testing.T) string {
	t.Helper()
	if m.Method != "" {
		return m.Method
	}
	var envelope struct {
		Result struct {
			Method string `json:"method"`
		} `json:"result"`
	}
	_ = json.Unmarshal([]byte(m.raw), &envelope)
	return envelope.Result.Method
}

// acpLog is the fake agent's protocol log: every line it read and everything it
// printed a marker for.
type acpLog struct {
	mu    sync.Mutex
	lines []string
	path  string
}

func newACPLog(t *testing.T) *acpLog {
	t.Helper()
	return &acpLog{path: filepath.Join(t.TempDir(), "acp.log")}
}

func (l *acpLog) read(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatal(err)
	}
	return string(data)
}

func (l *acpLog) messages(t *testing.T) []loggedMessage {
	t.Helper()
	var out []loggedMessage
	for _, line := range strings.Split(l.read(t), "\n") {
		if !strings.HasPrefix(line, "{") {
			continue
		}
		message := loggedMessage{raw: line}
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			t.Fatalf("the agent logged a line that is not JSON: %s", line)
		}
		out = append(out, message)
	}
	return out
}

// inbound is the messages Kin sent, in order. The fake agent logs a line it read
// before doing anything with it, and everything Kin sends is a request or a
// notification, so this is Kin's half of the conversation.
func (l *acpLog) inbound(t *testing.T, method string) []loggedMessage {
	t.Helper()
	var out []loggedMessage
	for _, message := range l.messages(t) {
		if message.Method == method {
			out = append(out, message)
		}
	}
	return out
}

func (l *acpLog) methods(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, message := range l.messages(t) {
		if message.Method != "" {
			out = append(out, message.Method)
		}
	}
	return out
}

// replyTo returns the answer Kin gave to the request with the given id — the
// answer to a reverse request, which is a response rather than a method.
func (l *acpLog) replyTo(t *testing.T, id string) string {
	t.Helper()
	for _, message := range l.messages(t) {
		if message.Method == "" && string(message.ID) == `"`+id+`"` {
			return message.raw
		}
	}
	t.Fatalf("nothing answered %s; the agent read:\n%s", id, l.read(t))
	return ""
}

func (l *acpLog) waitFor(t *testing.T, needle string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(l.read(t), needle) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the agent never reported %q; log:\n%s", needle, l.read(t))
}

// writeFakeACP writes the fake agent. It is a POSIX shell script for the same
// reason the other adapters' fakes are: the point is the bytes on the pipe, and
// a shell is the shortest honest way to put them there.
func writeFakeACP(t *testing.T, log *acpLog) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(log.path), "fake-acp")
	script := `#!/bin/sh
log="$ACP_FAKE_LOG"
mode="$ACP_FAKE_MODE"
printf 'ARGS:%s\n' "$*" >> "$log"

recv() {
  IFS= read -r req || return 1
  printf '%s\n' "$req" >> "$log"
  return 0
}
id_of() {
  printf '%s\n' "$1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}
method_of() {
  printf '%s\n' "$1" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p'
}
reply() {
  printf '{"jsonrpc":"2.0","id":"%s","result":%s}\n' "$1" "$2"
}
perm() {
  printf '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"toolCallId":"call-1","title":"Write file","kind":"edit","status":"pending","rawInput":{"path":"/tmp/x"}},"options":[{"optionId":"allow-once","name":"Allow","kind":"allow_once"},{"optionId":"allow-always","name":"Always","kind":"allow_always"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}\n'
}
# A question whose every option is a refusal: the protocol allows it, and there
# is nothing for a person to decide.
perm_strict() {
  printf '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"toolCallId":"call-1","title":"Write file","kind":"edit","status":"pending","rawInput":{"path":"/tmp/x"}},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}\n'
}

# initialize
recv || exit 2
# The claude adapter refuses a handshake whose clientInfo carries no version
# (-32602). The fake agent refuses it too, so a client that stops sending one
# fails here rather than on the one agent that checks.
case "$req" in
  *'"version":""'*) bad_version=1 ;;
  *'"clientInfo"'*'"version":"'*) bad_version=0 ;;
  *) bad_version=1 ;;
esac
if [ "$bad_version" = 1 ]; then
  printf '{"jsonrpc":"2.0","id":"%s","error":{"code":-32602,"message":"Invalid params"}}\n' "$(id_of "$req")"
  exit 4
fi
case "$mode" in
  speak_v2) reply "$(id_of "$req")" '{"protocolVersion":2,"agentCapabilities":{"loadSession":false}}' ;;
  no_load) reply "$(id_of "$req")" '{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}' ;;
  *) reply "$(id_of "$req")" '{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}' ;;
esac

# session/new or session/load
recv || exit 3
session='{"sessionId":"sess-1","configOptions":[{"id":"model","category":"model","currentValue":"fast","options":[{"value":"fast","name":"Fast"},{"value":"slow","name":"Slow"}]}],"modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default"},{"id":"acceptEdits","name":"Accept Edits"},{"id":"bypassPermissions","name":"Bypass Permissions"}]}}'
# An agent that publishes its ladder only as a config option.
if [ "$mode" = config_mode ]; then
  session='{"sessionId":"sess-1","configOptions":[{"id":"autonomy_level","category":"mode","currentValue":"auto-high","options":[{"value":"normal","name":"Auto (Off)"},{"value":"auto-high","name":"Auto (High)"}]}]}'
fi
# An agent that publishes no permission ladder at all (the protocol allows it).
if [ "$mode" = no_modes ]; then
  session='{"sessionId":"sess-1","configOptions":[{"id":"model","category":"model","currentValue":"fast","options":[{"value":"fast","name":"Fast"}]}]}'
fi
# An agent whose ladder exists but no longer uses the ids Kin maps to: the
# upgrade-renamed-the-rungs case, where running on its current rung would be a
# guess about what that rung does.
if [ "$mode" = renamed_modes ]; then
  session='{"sessionId":"sess-1","configOptions":[{"id":"model","category":"model","currentValue":"fast","options":[{"value":"fast","name":"Fast"}]}],"modes":{"currentModeId":"auto-high","availableModes":[{"id":"manual","name":"Manual"},{"id":"auto-high","name":"Auto (High)"}]}}'
fi
case "$(method_of "$req")" in
  session/load)
    session='{"sessionId":"sess-loaded","configOptions":[{"id":"model","category":"model","currentValue":"fast","options":[{"value":"fast","name":"Fast"},{"value":"slow","name":"Slow"}]}]}'
    case "$mode" in
      load_replay)
        printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-loaded","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"earlier question"}}}}\n'
        printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-loaded","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"earlier answer"}}}}\n'
        ;;
    esac
    ;;
esac
if [ "$mode" = slow_session ]; then
  printf 'NEW\n' >> "$log"
  # TERM is ignored on purpose: this mode exists to be cancelled while a request
  # is in flight, and it has to survive long enough to answer that request —
  # otherwise the test proves nothing about what Kin does with the answer.
  trap '' TERM
  sleep 0.5
fi
reply "$(id_of "$req")" "$session"

# Whatever Kin asks next: the mode and the model may be selected before the
# prompt, in either shape the protocol offers.
cmd=""
while recv; do
  case "$(method_of "$req")" in
    session/set_mode)
      if [ "$mode" = reject_set_mode ]; then
        printf '{"jsonrpc":"2.0","id":"%s","error":{"code":-32601,"message":"mode not supported"}}\n' "$(id_of "$req")"
      else
        reply "$(id_of "$req")" '{}'
      fi
      ;;
    session/set_config_option) reply "$(id_of "$req")" '{}' ;;
    session/prompt) cmd=prompt; break ;;
    *) exit 4 ;;
  esac
done
[ "$cmd" = prompt ] || exit 0
prompt_id="$(id_of "$req")"

case "$mode" in
  updates)
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working on it"},"messageId":"m1"}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"considering"}}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Read file","kind":"read","status":"pending","rawInput":{"path":"/tmp/x"},"locations":[{"path":"/tmp/x"}]}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"file body"}}]}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"plan","entries":[{"content":"step one","status":"pending","priority":"high"}]}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"usage_update","used":120,"size":1000}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"session_info_update","title":"named by the agent"}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"a_kind_from_a_newer_agent","value":1}}}\n'
    printf 'this line is not JSON at all\n'
    reply "$prompt_id" '{"stopReason":"end_turn","usage":{"inputTokens":11,"outputTokens":5,"totalTokens":18,"cachedReadTokens":2,"thoughtTokens":1}}'
    ;;
  permission)
    perm
    recv || exit 6
    case "$req" in
      *'"optionId":"allow-once"'*) stop=end_turn ;;
      *'"optionId":"reject-once"'*) stop=refusal ;;
      *) stop=cancelled ;;
    esac
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer was %s"}}}}\n' "$stop"
    reply "$prompt_id" "{\"stopReason\":\"$stop\"}"
    ;;
  permission_no_allow)
    perm_strict
    recv || exit 6
    case "$req" in
      *'"optionId":"reject-once"'*) stop=refusal ;;
      *) stop=cancelled ;;
    esac
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer was %s"}}}}\n' "$stop"
    reply "$prompt_id" "{\"stopReason\":\"$stop\"}"
    ;;
  cancel)
    printf 'READY\n' >> "$log"
    perm
    trap 'printf "TERM\n" >> "$log"; exit 0' TERM
    while recv; do :; done
    while :; do sleep 1; done
    ;;
  die_mid_turn)
    exit 7
    ;;
  stops_cancelled)
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"starting"}}}}\n'
    reply "$prompt_id" '{"stopReason":"cancelled"}'
    ;;
  subagent)
    # What the claude adapter sends for a subagent: no separate stream, just the
    # parent tool call's id in the protocol's extension field.
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"looking into it"},"_meta":{"claudeCode":{"parentToolUseId":"tool-parent"}}}}}\n'
    printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"tool-child","title":"Read file","kind":"read","status":"pending","_meta":{"claudeCode":{"parentToolUseId":"tool-parent"}}}}}\n'
    reply "$prompt_id" '{"stopReason":"end_turn"}'
    ;;
  *)
    reply "$prompt_id" '{"stopReason":"end_turn"}'
    ;;
esac
exit 0
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// harness is one configured adapter plus the log its fake agent writes.
type harness struct {
	adapter *Adapter
	log     *acpLog
	bin     string
}

func newAgent(t *testing.T, mode string, configure func(*Adapter)) *harness {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake agent is a shell script")
	}
	log := newACPLog(t)
	bin := writeFakeACP(t, log)
	t.Setenv("ACP_FAKE_MODE", mode)
	t.Setenv("ACP_FAKE_LOG", log.path)
	ad := &Adapter{Binary: bin, Version: "test"}
	if configure != nil {
		configure(ad)
	}
	return &harness{adapter: ad, log: log, bin: bin}
}

// start runs one turn and returns the handle.
func (a *harness) start(t *testing.T, spec adapter.TaskSpec) adapter.RunHandle {
	t.Helper()
	if spec.ID == "" {
		spec.ID = "task-1"
	}
	if spec.Agent == "" {
		spec.Agent = "acp"
	}
	if spec.Cwd == "" {
		spec.Cwd = t.TempDir()
	}
	if spec.Prompt == "" {
		spec.Prompt = "do the work"
	}
	handle, err := a.adapter.Start(context.Background(), spec)
	if err != nil {
		t.Fatalf("start the agent: %v", err)
	}
	return handle
}

func collectEvents(t *testing.T, handle adapter.RunHandle, timeout time.Duration) []adapter.Event {
	t.Helper()
	var events []adapter.Event
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-handle.Events():
			if !ok {
				return events
			}
			events = append(events, event)
		case <-timer.C:
			t.Fatalf("timed out waiting for events: %v", eventTypesOf(events))
		}
	}
}

func findEvent(t *testing.T, events []adapter.Event, typ string) adapter.Event {
	t.Helper()
	for _, event := range events {
		if event.Type == typ {
			return event
		}
	}
	t.Fatalf("no %s event in %v", typ, eventTypesOf(events))
	return adapter.Event{}
}

// eventNoticeTitle is what tells one adapter status line from another.
func eventNoticeTitle(t *testing.T, event adapter.Event) string {
	t.Helper()
	title, _ := payloadOf(t, event)["title"].(string)
	return title
}

// permissionNoticeOf finds the line the adapter leaves behind when a permission
// question never reached an inbox. An agent answered without a person is
// something the transcript has to show, so a missing line is a failure.
func permissionNoticeOf(t *testing.T, events []adapter.Event) string {
	t.Helper()
	for _, event := range events {
		if event.Type == "notice" && eventNoticeTitle(t, event) == "permission" {
			message, _ := payloadOf(t, event)["message"].(string)
			return message
		}
	}
	t.Fatalf("no permission notice in %v", eventTypesOf(events))
	return ""
}

func assertEventTypes(t *testing.T, events []adapter.Event, want ...string) {
	t.Helper()
	got := eventTypesOf(events)
	for _, typ := range want {
		found := false
		for _, current := range got {
			if current == typ {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("no %s event in %v", typ, got)
		}
	}
}

// messageTexts is every text an assistant message carries, in order.
func messageTexts(t *testing.T, events []adapter.Event) []string {
	t.Helper()
	var out []string
	for _, event := range events {
		if event.Type != "message" {
			continue
		}
		content, ok := payloadOf(t, event)["content"].([]any)
		if !ok {
			t.Fatalf("a message arrived without a content block: %s", event.Payload)
		}
		for _, item := range content {
			if block, ok := item.(map[string]any); ok {
				out = append(out, block["text"].(string))
			}
		}
	}
	return out
}

// messagePayload finds the one message whose text is exactly want.
func messagePayload(t *testing.T, events []adapter.Event, want string) map[string]any {
	t.Helper()
	var found map[string]any
	for _, event := range events {
		if event.Type != "message" {
			continue
		}
		payload := payloadOf(t, event)
		content, ok := payload["content"].([]any)
		if !ok {
			continue
		}
		for _, item := range content {
			if block, ok := item.(map[string]any); ok && block["text"] == want {
				if found != nil {
					t.Fatalf("two messages say %q", want)
				}
				found = payload
			}
		}
	}
	if found == nil {
		t.Fatalf("no message says %q of %d events", want, len(events))
	}
	return found
}

// assertRequest checks the envelope of one message Kin sent: the agent is a
// JSON-RPC peer, so a message without the version, the method or an id is one
// it has to guess at.
func assertRequest(t *testing.T, message loggedMessage) {
	t.Helper()
	var envelope struct {
		JSONRPC string `json:"jsonrpc"`
	}
	if err := json.Unmarshal([]byte(message.raw), &envelope); err != nil {
		t.Fatalf("unreadable message: %s", message.raw)
	}
	if envelope.JSONRPC != jsonRPCVersion {
		t.Fatalf("jsonrpc = %q in %s", envelope.JSONRPC, message.raw)
	}
	if len(message.ID) == 0 {
		t.Fatalf("a request with no id cannot be answered: %s", message.raw)
	}
}

// TestATurnSpeaksACPOverStdio is the whole handshake and one turn: initialize,
// open a session, send the prompt, and turn what comes back into events the
// console can draw.
func TestATurnSpeaksACPOverStdio(t *testing.T) {
	a := newAgent(t, "updates", nil)
	handle := a.start(t, adapter.TaskSpec{
		Execution: adapter.ExecutionRef{ID: "exec-1", Agent: "acp"},
	})
	events := collectEvents(t, handle, 10*time.Second)

	// The handshake: what Kin tells the agent about itself.
	initialize := a.log.inbound(t, methodInitialize)
	if len(initialize) != 1 {
		t.Fatalf("initialize sent %d times; agent read:\n%s", len(initialize), a.log.read(t))
	}
	assertRequest(t, initialize[0])
	var params struct {
		ProtocolVersion    int            `json:"protocolVersion"`
		ClientCapabilities map[string]any `json:"clientCapabilities"`
		ClientInfo         struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"clientInfo"`
	}
	if err := json.Unmarshal(initialize[0].Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ProtocolVersion != protocolVersion {
		t.Fatalf("protocolVersion = %d, want %d", params.ProtocolVersion, protocolVersion)
	}
	if params.ClientInfo.Name != clientName || params.ClientInfo.Version != "test" {
		t.Fatalf("clientInfo = %+v", params.ClientInfo)
	}
	// Kin answers no reverse request but the permission question, so it must not
	// claim it can serve files or a terminal.
	if len(params.ClientCapabilities) != 0 {
		t.Fatalf("clientCapabilities = %v, want none advertised", params.ClientCapabilities)
	}

	// The session and the prompt.
	newSession := a.log.inbound(t, methodSessionNew)
	if len(newSession) != 1 {
		t.Fatalf("session/new sent %d times", len(newSession))
	}
	var sessionParams struct {
		Cwd        string `json:"cwd"`
		McpServers []any  `json:"mcpServers"`
	}
	if err := json.Unmarshal(newSession[0].Params, &sessionParams); err != nil {
		t.Fatal(err)
	}
	if sessionParams.Cwd == "" {
		t.Fatal("the agent was not told which directory the turn runs in")
	}
	if sessionParams.McpServers == nil {
		t.Fatal("mcpServers must be present: the protocol requires the field")
	}
	if len(a.log.inbound(t, methodSessionPrompt)) != 1 {
		t.Fatalf("the prompt was not sent once:\n%s", a.log.read(t))
	}

	// The transcript.
	assertEventTypes(t, events, "task_started", "message", "tool_use", "tool_result",
		"plan", "notice", "raw_output", "result")
	started, ok := adapter.ParseStarted(findEvent(t, events, "task_started").Payload)
	if !ok || started.SessionRef != "sess-1" {
		t.Fatalf("task_started = %+v", started)
	}
	texts := messageTexts(t, events)
	if len(texts) != 2 || texts[0] != "working on it" || texts[1] != "considering" {
		t.Fatalf("the agent's own words did not survive the trip: %q", texts)
	}
	// …and the second one is marked as reasoning. The console decides where a
	// message goes from its role and phase; a thought that arrives looking like
	// an assistant message is drawn as the answer, so a turn ending on a thought
	// would show the agent's private reasoning as the reply.
	thought := messagePayload(t, events, "considering")
	if thought["role"] != "reasoning" || thought["phase"] != "progress" {
		t.Fatalf("the agent's reasoning is not marked as reasoning: %v", thought)
	}
	toolUse := payloadOf(t, findEvent(t, events, "tool_use"))
	if toolUse["tool_use_id"] != "tool-1" || toolUse["name"] != "Read file" {
		t.Fatalf("tool_use = %v", toolUse)
	}
	if output := payloadOf(t, findEvent(t, events, "tool_result"))["output"]; output != "file body" {
		t.Fatalf("tool_result output = %v", output)
	}

	result := payloadOf(t, findEvent(t, events, "result"))
	if result["is_error"] != false || result["stop_reason"] != stopEndTurn {
		t.Fatalf("result = %v", result)
	}
	// The agent's own usage is shown, not booked: the engine books whatever a
	// result carries as this turn's tokens, and ACP's `Usage` does not say
	// whether its numbers are this turn's or the session's (see finishTurn).
	for _, key := range []string{"input_tokens", "output_tokens", "tokens_in", "tokens_out",
		"cache_read_tokens", "reasoning_output_tokens", "cost_usd"} {
		if value, ok := result[key]; ok {
			t.Fatalf("the result carries %s=%v: an unverified number became this turn's accounting", key, value)
		}
	}
	reported := map[string]any(nil)
	for _, event := range events {
		if event.Type != "notice" {
			continue
		}
		payload := payloadOf(t, event)
		if payload["title"] == "usage reported" {
			reported = payload
		}
	}
	if reported == nil {
		t.Fatalf("the agent's usage was reported nowhere: %v", eventTypesOf(events))
	}
	// Every number the agent sent, including the total (a required field in the
	// schema, so an agent that omits it is the one out of spec, not Kin).
	if reported["reported_input_tokens"] != float64(11) ||
		reported["reported_output_tokens"] != float64(5) ||
		reported["reported_total_tokens"] != float64(18) ||
		reported["reported_cache_read_tokens"] != float64(2) ||
		reported["reported_reasoning_tokens"] != float64(1) {
		t.Fatalf("the agent's own usage was lost: %v", reported)
	}
	if message, _ := reported["message"].(string); !strings.Contains(message, "records nothing") {
		t.Fatalf("the status line does not say the numbers are unrecorded: %q", message)
	}
	// A non-JSON line from the agent is recorded, not fatal: the agent is a
	// program on the other end of a pipe, and one of them writes a banner.
	raw := payloadOf(t, findEvent(t, events, "raw_output"))
	if !strings.Contains(raw["line"].(string), "not JSON") {
		t.Fatalf("raw_output = %v", raw)
	}
}

// TestAResumedTurnLoadsTheConversationWithoutWritingItTwice: the protocol makes
// the agent replay the whole conversation as ordinary updates, so a client that
// appends them writes the history into the transcript a second time.
func TestAResumedTurnLoadsTheConversationWithoutWritingItTwice(t *testing.T) {
	a := newAgent(t, "load_replay", nil)
	handle := a.start(t, adapter.TaskSpec{SessionRef: "sess-earlier"})
	events := collectEvents(t, handle, 10*time.Second)

	load := a.log.inbound(t, methodSessionLoad)
	if len(load) != 1 {
		t.Fatalf("session/load sent %d times; agent read:\n%s", len(load), a.log.read(t))
	}
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(load[0].Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.SessionID != "sess-earlier" {
		t.Fatalf("the agent was asked to load %q", params.SessionID)
	}
	if len(a.log.inbound(t, methodSessionNew)) != 0 {
		t.Fatal("a resumed turn opened a new session instead of loading the old one")
	}

	// The task stays on the session the user knows, not on whatever the agent
	// calls it internally.
	started, ok := adapter.ParseStarted(findEvent(t, events, "task_started").Payload)
	if !ok || started.SessionRef != "sess-earlier" {
		t.Fatalf("task_started = %+v", started)
	}
	// The replay is not the turn's output.
	for _, text := range messageTexts(t, events) {
		if strings.Contains(text, "earlier") {
			t.Fatalf("the agent's replay was written into the transcript: %q", text)
		}
	}
	if err := json.Unmarshal(findEvent(t, events, "result").Payload, &map[string]any{}); err != nil {
		t.Fatal(err)
	}
}

// TestALoadThatReplaysNothingSaysSo: a resumed turn whose context nobody can
// see is worse than one that admits it, because the answer looks like it came
// from a conversation the user had.
func TestALoadThatReplaysNothingSaysSo(t *testing.T) {
	a := newAgent(t, "load_silent", nil)
	events := collectEvents(t, a.start(t, adapter.TaskSpec{SessionRef: "sess-earlier"}), 10*time.Second)

	found := false
	for _, event := range events {
		if event.Type != "notice" {
			continue
		}
		payload := payloadOf(t, event)
		if title, _ := payload["title"].(string); strings.Contains(title, "without replay") {
			found = true
		}
	}
	if !found {
		t.Fatalf("a load that replayed nothing passed without a word: %v", eventTypesOf(events))
	}
}

// TestAnAgentThatCannotLoadStartsANewSession: `session/load` is a capability,
// and asking an agent that never claimed it turns a resume into a failed turn.
func TestAnAgentThatCannotLoadStartsANewSession(t *testing.T) {
	a := newAgent(t, "no_load", nil)
	events := collectEvents(t, a.start(t, adapter.TaskSpec{SessionRef: "sess-earlier"}), 10*time.Second)

	if len(a.log.inbound(t, methodSessionLoad)) != 0 {
		t.Fatal("session/load was sent to an agent that does not support it")
	}
	if len(a.log.inbound(t, methodSessionNew)) != 1 {
		t.Fatal("the turn did not fall back to a new session")
	}
	started, ok := adapter.ParseStarted(findEvent(t, events, "task_started").Payload)
	if !ok || started.SessionRef != "sess-1" {
		t.Fatalf("task_started = %+v", started)
	}
	if len(a.log.inbound(t, methodSessionPrompt)) != 1 {
		t.Fatal("the turn never ran")
	}
	// The task had a session on this agent and it is not being continued. That is
	// context the user believes is still there, so the transcript says otherwise.
	var said string
	for _, event := range events {
		if event.Type != "notice" {
			continue
		}
		payload := payloadOf(t, event)
		if payload["title"] == "session not reloaded" {
			said, _ = payload["message"].(string)
		}
	}
	if said == "" {
		t.Fatalf("the earlier session was dropped without a word: %v", eventTypesOf(events))
	}
}

func TestTheModelIsChosenThroughTheAgentsOwnSelector(t *testing.T) {
	t.Run("a model the agent offers", func(t *testing.T) {
		a := newAgent(t, "updates", nil)
		events := collectEvents(t, a.start(t, adapter.TaskSpec{Model: "fast"}), 10*time.Second)

		set := a.log.inbound(t, methodSetConfigOption)
		if len(set) != 1 {
			t.Fatalf("session/set_config_option sent %d times; agent read:\n%s", len(set), a.log.read(t))
		}
		var params struct {
			SessionID string `json:"sessionId"`
			ConfigID  string `json:"configId"`
			Value     string `json:"value"`
		}
		if err := json.Unmarshal(set[0].Params, &params); err != nil {
			t.Fatal(err)
		}
		if params.ConfigID != "model" || params.Value != "fast" || params.SessionID != "sess-1" {
			t.Fatalf("params = %+v", params)
		}
		// The order matters: the model is set before the turn starts, never after.
		if methods := a.log.methods(t); indexOf(methods, methodSetConfigOption) > indexOf(methods, methodSessionPrompt) {
			t.Fatalf("the prompt was sent before the model was chosen: %v", methods)
		}
		if started, _ := adapter.ParseStarted(findEvent(t, events, "task_started").Payload); started.Model != "fast" {
			t.Fatalf("the transcript does not say which model ran: %+v", started)
		}
	})

	t.Run("a model the agent does not offer", func(t *testing.T) {
		a := newAgent(t, "updates", nil)
		events := collectEvents(t, a.start(t, adapter.TaskSpec{Model: "ghost"}), 10*time.Second)

		if len(a.log.inbound(t, methodSetConfigOption)) != 0 {
			t.Fatal("an unknown model was selected anyway")
		}
		if len(a.log.inbound(t, methodSessionPrompt)) != 0 {
			t.Fatal("the turn ran on a model the user did not ask for")
		}
		message := string(payloadOf(t, findEvent(t, events, "error"))["message"].(string))
		if !strings.Contains(message, "ghost") {
			t.Fatalf("the error does not name the model: %q", message)
		}
	})
}

// TestKinSelectsTheAgentsOwnModeRung: the permission ladder belongs to the
// agent, and `session/new` is where it publishes the rungs. Kin's three modes
// are a preference; the rung is chosen from what the agent offered, before the
// prompt, because a mode that arrives after the turn has started changes
// nothing about it.
func TestKinSelectsTheAgentsOwnModeRung(t *testing.T) {
	modes := map[string]string{
		adapter.PermissionDefault:     "default",
		adapter.PermissionAcceptEdits: "acceptEdits",
		adapter.PermissionYOLO:        "bypassPermissions",
	}
	for _, tc := range []struct{ kin, rung string }{
		{adapter.PermissionDefault, "default"},
		{adapter.PermissionAcceptEdits, "acceptEdits"},
		{adapter.PermissionYOLO, "bypassPermissions"},
	} {
		t.Run(tc.kin, func(t *testing.T) {
			a := newAgent(t, "updates", func(ad *Adapter) { ad.Modes = modes })
			events := collectEvents(t, a.start(t, adapter.TaskSpec{PermissionMode: tc.kin}), 10*time.Second)

			requests := a.log.inbound(t, methodSessionSetMode)
			if len(requests) != 1 {
				t.Fatalf("session/set_mode sent %d times; agent read:\n%s", len(requests), a.log.read(t))
			}
			var params setModeParams
			if err := json.Unmarshal(requests[0].Params, &params); err != nil {
				t.Fatal(err)
			}
			if params.ModeID != tc.rung || params.SessionID != "sess-1" {
				t.Fatalf("params = %+v", params)
			}
			if methods := a.log.methods(t); indexOf(methods, methodSessionSetMode) > indexOf(methods, methodSessionPrompt) {
				t.Fatalf("the prompt was sent before the mode was chosen: %v", methods)
			}
			for _, event := range events {
				if event.Type == "notice" && eventNoticeTitle(t, event) == "permission mode not applied" {
					t.Fatalf("a mode this agent applies was reported as unapplied: %s", event.Payload)
				}
			}
		})
	}
}

// TestAModeRungTheAgentDidNotOfferIsRefused: the agent publishes a ladder, but
// not the rung Kin maps to — the upgrade-renamed-the-rungs case. Running on
// whatever rung it kept could mean approving everything (droid ships that way),
// so the turn stops before the prompt instead of guessing.
func TestAModeRungTheAgentDidNotOfferIsRefused(t *testing.T) {
	t.Run("modes ladder", func(t *testing.T) {
		a := newAgent(t, "updates", func(ad *Adapter) {
			ad.Modes = map[string]string{adapter.PermissionYOLO: "agent-full-access"}
		})
		events := collectEvents(t, a.start(t, adapter.TaskSpec{PermissionMode: adapter.PermissionYOLO}), 10*time.Second)

		if len(a.log.inbound(t, methodSessionSetMode)) != 0 {
			t.Fatal("a mode the agent did not offer was selected anyway")
		}
		if len(a.log.inbound(t, methodSessionPrompt)) != 0 {
			t.Fatal("the turn ran on a mode Kin could not place")
		}
		message := string(payloadOf(t, findEvent(t, events, "error"))["message"].(string))
		for _, want := range []string{"agent-full-access", "default, acceptEdits, bypassPermissions", "refusing"} {
			if !strings.Contains(message, want) {
				t.Fatalf("the error does not say %q: %q", want, message)
			}
		}
	})

	t.Run("config option ladder", func(t *testing.T) {
		a := newAgent(t, "config_mode", func(ad *Adapter) {
			ad.Modes = map[string]string{adapter.PermissionYOLO: "agent-full-access"}
		})
		events := collectEvents(t, a.start(t, adapter.TaskSpec{PermissionMode: adapter.PermissionYOLO}), 10*time.Second)

		if len(a.log.inbound(t, methodSetConfigOption)) != 0 {
			t.Fatal("a mode value the agent did not offer was selected anyway")
		}
		if len(a.log.inbound(t, methodSessionPrompt)) != 0 {
			t.Fatal("the turn ran on a mode Kin could not place")
		}
		message := string(payloadOf(t, findEvent(t, events, "error"))["message"].(string))
		// The message lists the rungs the agent did publish, in its own words.
		if !strings.Contains(message, "normal, auto-high") {
			t.Fatalf("the error does not list the agent's own modes: %q", message)
		}
	})
}

// TestAnAgentWithNoModeLadderWarnsAndRuns: an agent that publishes no ladder at
// all gives Kin nothing to select. The node's ceiling already treats an
// unappliable non-default mode as a bypass; for a turn that was allowed to run,
// the transcript says the mode was not applied instead of failing over a label.
func TestAnAgentWithNoModeLadderWarnsAndRuns(t *testing.T) {
	a := newAgent(t, "no_modes", func(ad *Adapter) {
		ad.Modes = map[string]string{adapter.PermissionYOLO: "agent-full-access"}
	})
	events := collectEvents(t, a.start(t, adapter.TaskSpec{PermissionMode: adapter.PermissionYOLO}), 10*time.Second)

	if len(a.log.inbound(t, methodSessionSetMode)) != 0 {
		t.Fatal("a mode was selected from an agent that published none")
	}
	if len(a.log.inbound(t, methodSessionPrompt)) != 1 {
		t.Fatal("the turn did not run at all")
	}
	var said string
	for _, event := range events {
		if event.Type != "notice" {
			continue
		}
		payload := payloadOf(t, event)
		if payload["mode"] != adapter.PermissionYOLO {
			continue
		}
		said, _ = payload["message"].(string)
	}
	for _, want := range []string{"agent-full-access", "publishes no mode ladder"} {
		if !strings.Contains(said, want) {
			t.Fatalf("the notice does not say %q: %q", want, said)
		}
	}
}

// TestAnAgentThatRefusesTheModeStopsTheTurn: the rung was offered, and the
// agent still answered the selection with an error. Continuing would run the
// turn in a mode the person did not choose, so it stops and names both.
func TestAnAgentThatRefusesTheModeStopsTheTurn(t *testing.T) {
	a := newAgent(t, "reject_set_mode", func(ad *Adapter) {
		ad.Modes = map[string]string{adapter.PermissionDefault: "default"}
	})
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	if len(a.log.inbound(t, methodSessionSetMode)) != 1 {
		t.Fatal("the mapped rung was not selected")
	}
	if len(a.log.inbound(t, methodSessionPrompt)) != 0 {
		t.Fatal("the turn ran after the agent refused its mode")
	}
	message := string(payloadOf(t, findEvent(t, events, "error"))["message"].(string))
	for _, want := range []string{`"default" mode`, `"default" rung`, "mode not supported"} {
		if !strings.Contains(message, want) {
			t.Fatalf("the error does not say %q: %q", want, message)
		}
	}
}

// TestAnAgentThatPublishesModesAsAConfigOption: some agents expose the same
// ladder through `configOptions` instead of `modes` (droid and codex publish
// both; this fake publishes only the option). The mode then goes out as a
// config option, and the turn waits for that answer before prompting.
func TestAnAgentThatPublishesModesAsAConfigOption(t *testing.T) {
	a := newAgent(t, "config_mode", func(ad *Adapter) {
		ad.Modes = map[string]string{adapter.PermissionDefault: "normal"}
	})
	collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	requests := a.log.inbound(t, methodSetConfigOption)
	if len(requests) != 1 {
		t.Fatalf("session/set_config_option sent %d times; agent read:\n%s", len(requests), a.log.read(t))
	}
	var params setConfigOptionParams
	if err := json.Unmarshal(requests[0].Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ConfigID != "autonomy_level" || params.Value != "normal" {
		t.Fatalf("params = %+v", params)
	}
	if methods := a.log.methods(t); indexOf(methods, methodSetConfigOption) > indexOf(methods, methodSessionPrompt) {
		t.Fatalf("the prompt was sent before the mode was chosen: %v", methods)
	}
}

// TestASubagentsWorkIsMarked: ACP has no parent field, so an agent that wants
// its subagents distinguishable says so in `_meta`. Ignoring that makes a
// subagent's narration read as the main agent's answer, and its tool calls look
// like the main agent's own.
func TestASubagentsWorkIsMarked(t *testing.T) {
	a := newAgent(t, "subagent", nil)
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	message := messagePayload(t, events, "looking into it")
	if message["sidechain"] != true {
		t.Fatalf("a subagent message is not marked: %v", message)
	}
	if message["phase"] != messagePhaseProgress {
		t.Fatalf("a subagent message is drawn as the answer: %v", message)
	}
	if message["parent_tool_use_id"] != "tool-parent" {
		t.Fatalf("the parent was dropped: %v", message)
	}
	tool := payloadOf(t, findEvent(t, events, "tool_use"))
	if tool["parent_tool_use_id"] != "tool-parent" || tool["sidechain"] != true {
		t.Fatalf("a subagent tool call is not marked: %v", tool)
	}
}

// TestAPermissionQuestionGoesToKinAndTheAnswerComesBack is the M2.6 approval
// path over real pipes: the agent blocks on a question, the question lands in
// Kin's inbox with the turn it belongs to, and the person's decision is what
// the agent is told.
func TestAPermissionQuestionGoesToKinAndTheAnswerComesBack(t *testing.T) {
	for _, tc := range []struct {
		name       string
		decision   string
		wantOption string
		wantError  bool
	}{
		{name: "approved", decision: "approved", wantOption: "allow-once"},
		{name: "denied", decision: "denied", wantOption: "reject-once", wantError: true},
		// A question that expires is answered `cancelled`, and an agent whose
		// question was cancelled stops the turn rather than finishing it: the tool
		// call it asked about never ran, so the turn is not a completed answer.
		{name: "expired", decision: "expired", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/internal/approvals":
					w.WriteHeader(http.StatusCreated)
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "approval-1"})
				case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/wait"):
					_ = json.NewEncoder(w).Encode(map[string]any{"decision": tc.decision})
				default:
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(inbox.Close)

			a := newAgent(t, "permission", func(ad *Adapter) {
				ad.DaemonURL = inbox.URL
				ad.Token = "token-1"
			})
			events := collectEvents(t, a.start(t, adapter.TaskSpec{
				Execution: adapter.ExecutionRef{ID: "exec-1", Agent: "acp"},
			}), 10*time.Second)

			answer := a.log.replyTo(t, "perm-1")
			var response struct {
				Result struct {
					Outcome struct {
						Outcome  string `json:"outcome"`
						OptionID string `json:"optionId"`
					} `json:"outcome"`
				} `json:"result"`
			}
			if err := json.Unmarshal([]byte(answer), &response); err != nil {
				t.Fatal(err)
			}
			outcome := response.Result.Outcome
			if tc.wantOption == "" {
				if outcome.Outcome != "cancelled" {
					t.Fatalf("a question nobody answered was decided anyway: %+v", outcome)
				}
			} else if outcome.Outcome != "selected" || outcome.OptionID != tc.wantOption {
				t.Fatalf("the agent was told %+v, want %s", outcome, tc.wantOption)
			}

			// The question is recorded once, by whoever owns the row. Here that
			// is the inbox this test pointed the adapter at: creating the row
			// is what makes the engine append `approval_requested` (with the
			// approval id) to the task. A second record from the adapter would
			// put one question in the transcript twice — and the copy would
			// arrive after the person had already answered it.
			for _, event := range events {
				if event.Type == "approval_requested" {
					t.Fatalf("the adapter recorded a question that was already in the inbox: %s", event.Payload)
				}
				if event.Type == "notice" && eventNoticeTitle(t, event) == "permission" {
					t.Fatalf("the adapter recorded a question that was already in the inbox: %s", event.Payload)
				}
			}
			if result := payloadOf(t, findEvent(t, events, "result")); result["is_error"] != tc.wantError {
				t.Fatalf("result = %v, want is_error %v", result, tc.wantError)
			}
		})
	}
}

// TestAPermissionQuestionWithoutAKinToAsk: an agent launched by a daemon with
// no inbox still has to be answered. Blocking forever is the one outcome the
// protocol does not allow.
func TestAPermissionQuestionWithoutAKinToAsk(t *testing.T) {
	a := newAgent(t, "permission", nil)
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	answer := a.log.replyTo(t, "perm-1")
	if !strings.Contains(answer, `"outcome":{"outcome":"cancelled"}`) {
		t.Fatalf("the agent was answered %s", answer)
	}
	if message := permissionNoticeOf(t, events); !strings.Contains(message, "Write file") ||
		!strings.Contains(message, "cancelled") {
		t.Fatalf("the transcript records the question as %q", message)
	}
}

// TestAQuestionWithNoAllowOptionNeverBecomesAnApproval: the protocol lets an
// agent ask something Kin can only refuse — a question whose every option is a
// refusal, or one with no options at all. There is nothing for a person to
// decide, so no approval is created, and the transcript must not claim there is
// one waiting: `approval_requested` is what the console draws as "needs your
// approval", and the card it points at would never exist.
func TestAQuestionWithNoAllowOptionNeverBecomesAnApproval(t *testing.T) {
	var creates atomic.Int32
	inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		creates.Add(1)
		http.NotFound(w, r)
	}))
	t.Cleanup(inbox.Close)

	a := newAgent(t, "permission_no_allow", func(ad *Adapter) {
		ad.DaemonURL = inbox.URL
		ad.Token = "token-1"
	})
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	if answer := a.log.replyTo(t, "perm-1"); !strings.Contains(answer, `"optionId":"reject-once"`) {
		t.Fatalf("a question Kin could only refuse was answered %s", answer)
	}
	if n := creates.Load(); n != 0 {
		t.Fatalf("a question with no allow option reached the inbox %d times", n)
	}
	for _, event := range events {
		if event.Type == "approval_requested" {
			t.Fatalf("the transcript asks for approval of something that was already refused: %s", event.Payload)
		}
	}
	if message := permissionNoticeOf(t, events); !strings.Contains(message, "Write file") ||
		!strings.Contains(message, "reject-once") {
		t.Fatalf("the transcript records the question as %q", message)
	}
}

// TestCancelAnswersTheOpenQuestionThenStopsTheAgent is the cascade the protocol
// requires: `session/cancel` goes out, the question the agent is blocked on is
// answered `cancelled` (the connection stays open for exactly that reason), and
// only then does the process get a signal.
func TestCancelAnswersTheOpenQuestionThenStopsTheAgent(t *testing.T) {
	const cancelGrace = 80 * time.Millisecond
	// An inbox nobody answers from: the question is open when the turn is
	// cancelled, which is the only way to test the cascade.
	inbox := newFakeInbox(t, "")
	a := newAgent(t, "cancel", func(ad *Adapter) {
		ad.DaemonURL = inbox.server.URL
		ad.Token = "token-1"
		ad.HTTPClient = inbox.server.Client()
		ad.CancelGrace = cancelGrace
		ad.KillGrace = 2 * time.Second
	})
	handle := a.start(t, adapter.TaskSpec{})
	a.log.waitFor(t, "READY", 5*time.Second)

	started := time.Now()
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	events := collectEvents(t, handle, 10*time.Second)
	elapsed := time.Since(started)

	logged := a.log.read(t)
	if len(a.log.inbound(t, methodSessionCancel)) != 1 {
		t.Fatalf("session/cancel was not sent; the agent read:\n%s", logged)
	}
	answer := a.log.replyTo(t, "perm-1")
	if !strings.Contains(answer, `"outcome":{"outcome":"cancelled"}`) {
		t.Fatalf("the agent was left waiting on a question: %s", answer)
	}
	// Both have to arrive, and in this order: an agent told "cancelled" by a
	// client that never said why has to guess, and one whose pipe closed first
	// never hears anything at all.
	cancelAt := strings.Index(logged, `"method":"session/cancel"`)
	answerAt := strings.Index(logged, `"id":"perm-1"`)
	termAt := strings.Index(logged, "TERM")
	for name, index := range map[string]int{"session/cancel": cancelAt, "the answer to the question": answerAt, "SIGTERM": termAt} {
		if index < 0 {
			t.Fatalf("%s never happened; the agent saw:\n%s", name, logged)
		}
	}
	if cancelAt > answerAt || answerAt > termAt {
		t.Fatalf("the cascade is out of order; the agent saw:\n%s", logged)
	}
	if elapsed < cancelGrace {
		t.Fatalf("the agent was killed after %v, before the %v it was given to stop", elapsed, cancelGrace)
	}
	for _, event := range events {
		// A cancelled turn is not a failed one: the agent was stopped, it did not
		// fall over, and the transcript must not claim otherwise. What it does show
		// is the question that was open when the turn ended.
		if event.Type == "error" || event.Type == "result" {
			t.Fatalf("a cancelled turn reported %v", eventTypesOf(events))
		}
	}
	if len(events) == 0 {
		t.Fatal("the cancelled turn left no trace of the question it was waiting on")
	}
}

// TestACancelBeforeTheSessionExistsNeverReachesTheAgent is the window a cancel
// has no notification for: `session/new` has been sent and not yet answered, so
// there is no session id to put in `session/cancel`. The turn still has to
// stop — the pipeline's next step is the prompt itself, and a cancelled turn
// that hands the agent a full prompt is a turn doing work the user stopped.
func TestACancelBeforeTheSessionExistsNeverReachesTheAgent(t *testing.T) {
	a := newAgent(t, "slow_session", func(ad *Adapter) {
		ad.CancelGrace = 50 * time.Millisecond
		// Long enough that the answer to `session/new` arrives while the agent is
		// still alive: the point of the test is what Kin does with that answer.
		ad.KillGrace = 1500 * time.Millisecond
	})
	handle := a.start(t, adapter.TaskSpec{})
	a.log.waitFor(t, "NEW", 5*time.Second)

	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	collectEvents(t, handle, 10*time.Second)

	logged := a.log.read(t)
	if prompts := a.log.inbound(t, methodSessionPrompt); len(prompts) != 0 {
		t.Fatalf("the cancelled turn still prompted the agent:\n%s", logged)
	}
	// Nothing to notify, so nothing is: an agent that never opened a session
	// cannot be told to cancel one.
	if cancels := a.log.inbound(t, methodSessionCancel); len(cancels) != 0 {
		t.Fatalf("a session that never existed was cancelled:\n%s", logged)
	}
}

// TestNoPermissionModeMakesThisAgentRunUnattended answers the probe a Node uses
// as its permission ceiling.
//
// The question is what a mode does, and for this agent the answer is not
// "nothing": Kin can apply no mode, and — the part that decides it — the
// protocol lets the agent run a tool call without asking anyone. So a turn in a
// mode that means "stop asking" can execute unattended on a machine whose
// operator never agreed to that, and the ceiling must treat it as bypassed. The
// generic answer for an agent with no approval channel of its own is the same
// ("accept_edits is the bypass yolo is"), which is what the probe exists to let
// an adapter correct when it can do better. This adapter cannot.
func TestNoPermissionModeMakesThisAgentRunUnattended(t *testing.T) {
	reg, err := NewPluginFactory(PluginConfig{ID: "acp-test", Name: "ACP test"}).
		Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		mode string
		want bool
	}{
		{want: false, mode: adapter.PermissionDefault},
		{want: false, mode: ""},
		{want: true, mode: adapter.PermissionAcceptEdits},
		{want: true, mode: adapter.PermissionYOLO},
		{want: true, mode: "bypass"}, // an alias of yolo
	} {
		if got := adapter.AutoApprovesAll(reg.Runner, tc.mode); got != tc.want {
			t.Fatalf("AutoApprovesAll(%q) = %v, want %v", tc.mode, got, tc.want)
		}
	}
}

// TestAGradedModeIsNotBypassWhenTheAgentCanApplyIt: once Kin can select the
// agent's graded rung, accept_edits is what it says — edits auto-accepted, other
// actions still asked about — and only yolo reports the bypass ceiling. Without
// the mapping the conservative answer stands, which the test above pins.
func TestAGradedModeIsNotBypassWhenTheAgentCanApplyIt(t *testing.T) {
	reg, err := NewPluginFactory(PluginConfig{
		ID: "acp-test", Name: "ACP test",
		Modes: map[string]string{
			adapter.PermissionDefault:     "default",
			adapter.PermissionAcceptEdits: "acceptEdits",
			adapter.PermissionYOLO:        "bypassPermissions",
		},
	}).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		mode string
		want bool
	}{
		{mode: adapter.PermissionDefault, want: false},
		{mode: adapter.PermissionAcceptEdits, want: false},
		{mode: adapter.PermissionYOLO, want: true},
	} {
		if got := adapter.AutoApprovesAll(reg.Runner, tc.mode); got != tc.want {
			t.Fatalf("AutoApprovesAll(%q) = %v, want %v", tc.mode, got, tc.want)
		}
	}

	// An agent with no approval channel is never gated, whatever mode says.
	unattended, err := NewPluginFactory(PluginConfig{
		ID: "acp-unattended", Name: "ACP unattended", Unattended: true,
	}).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{adapter.PermissionDefault, adapter.PermissionAcceptEdits, adapter.PermissionYOLO} {
		if !adapter.AutoApprovesAll(unattended.Runner, mode) {
			t.Fatalf("AutoApprovesAll(%q) = false for an agent that never asks", mode)
		}
	}

	// A mapped rung that was measured approving everything is a bypass even
	// though the rung exists: the name is not the gate (droid's auto-low).
	droidish, err := NewPluginFactory(PluginConfig{
		ID: "acp-droidish", Name: "ACP droidish",
		Modes: map[string]string{
			adapter.PermissionDefault:     "normal",
			adapter.PermissionAcceptEdits: "auto-low",
			adapter.PermissionYOLO:        "auto-high",
		},
		AcceptEditsBypasses: true,
	}).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !adapter.AutoApprovesAll(droidish.Runner, adapter.PermissionAcceptEdits) {
		t.Fatal("a rung measured as all-approving was reported as a gate")
	}
	if adapter.AutoApprovesAll(droidish.Runner, adapter.PermissionDefault) {
		t.Fatal("the default mode was reported as a bypass")
	}
}

// TestTheHandshakeNamesAVersion: `clientInfo.version` is required by the
// protocol and enforced by the claude adapter, which answers a versionless
// `initialize` with -32602. Three of the four agents accept it without one,
// which is how Kin shipped a handshake that the fourth refused; the fake agent
// now refuses it too, and this pins that a caller who never set a version still
// completes the handshake.
func TestTheHandshakeNamesAVersion(t *testing.T) {
	a := newAgent(t, "updates", func(ad *Adapter) { ad.Version = "" })
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	for _, event := range events {
		if event.Type == "error" {
			t.Fatalf("the handshake failed without a version: %s", event.Payload)
		}
	}
	assertEventTypes(t, events, "result")
}

// TestAnAgentThatNeverAsksSaysSo: a turn on an agent with no approval channel
// opens with a warning, because there is no card coming and the reader should
// know that before the edits happen.
func TestAnAgentThatNeverAsksSaysSo(t *testing.T) {
	a := newAgent(t, "updates", func(ad *Adapter) { ad.Unattended = true })
	events := collectEvents(t, a.start(t, adapter.TaskSpec{PermissionMode: adapter.PermissionYOLO}), 10*time.Second)

	var said bool
	for _, event := range events {
		if event.Type == "notice" && eventNoticeTitle(t, event) == "agent does not ask" {
			said = true
		}
		if event.Type == "notice" && eventNoticeTitle(t, event) == "permission mode not applied" {
			t.Fatalf("an agent with no ladder was also told its mode is unmapped: %s", event.Payload)
		}
	}
	if !said {
		t.Fatalf("an unattended agent ran without saying so: %v", eventTypesOf(events))
	}
}

// TestAPermissionModeThisAgentCannotHonourIsSaidOutLoud: ACP has no way to run
// without asking, so a user who chose a mode that means "stop asking" is about
// to be asked anyway. Saying so in the transcript is the difference between a
// setting that did not apply and a setting that looks broken.
func TestAPermissionModeThisAgentCannotHonourIsSaidOutLoud(t *testing.T) {
	for _, tc := range []struct {
		mode     string
		wantSaid bool
	}{
		{mode: adapter.PermissionYOLO, wantSaid: true},
		{mode: adapter.PermissionAcceptEdits, wantSaid: true},
		{mode: adapter.PermissionDefault},
		{mode: ""},
	} {
		t.Run("mode "+tc.mode, func(t *testing.T) {
			a := newAgent(t, "updates", nil)
			events := collectEvents(t, a.start(t, adapter.TaskSpec{PermissionMode: tc.mode}), 10*time.Second)

			var said map[string]any
			for _, event := range events {
				if event.Type != "notice" {
					continue
				}
				if payload := payloadOf(t, event); payload["mode"] != nil {
					said = payload
				}
			}
			if !tc.wantSaid {
				if said != nil {
					t.Fatalf("a mode this agent applies was reported as unapplied: %v", said)
				}
				return
			}
			if said == nil {
				t.Fatalf("mode %q was accepted and silently ignored: %v", tc.mode, eventTypesOf(events))
			}
			message, _ := said["message"].(string)
			if !strings.Contains(message, "not applied") {
				t.Fatalf("the notice does not say what happens instead: %v", said)
			}
		})
	}
}

// TestACancelAfterTheRunEndedIsNotAPanic: the engine cancels tasks whose turns
// have already finished — a multi-step task cancels every step's handle — and
// this adapter's failure paths write to the transcript. A send on the closed
// channel is a panic, and a panic in an engine goroutine takes the daemon and
// every turn on it down with it.
// TestACancelAfterTheRunEndedIsNotAPanic: the guard it exercises is layered, and
// the outer layer is what this test can see.
//
// `emit` refuses to send once the run has finished (its `eventsClosed` flag),
// waits on `done` so a sender already blocked on a full buffer gives up, and
// recovers as a last resort. Only the last of the three turns a mistake into a
// visible failure — deleting the flag alone leaves this test green, because the
// recover swallows the send. Removing the whole guard is what makes it panic, so
// that is the change this test pins; the flag is depth, not the proof.
func TestACancelAfterTheRunEndedIsNotAPanic(t *testing.T) {
	a := newAgent(t, "updates", func(ad *Adapter) {
		ad.CancelGrace = 20 * time.Millisecond
		ad.KillGrace = 20 * time.Millisecond
	})
	handle := a.start(t, adapter.TaskSpec{})
	events := collectEvents(t, handle, 10*time.Second)
	if len(events) == 0 {
		t.Fatal("the turn produced no events")
	}

	// The run is over and its channel is closed; this is the cancel that used to
	// panic on the warning its own failed write produced.
	if err := handle.Cancel(); err != nil {
		t.Fatalf("cancel after the run ended: %v", err)
	}
}

// TestAnAgentThatStopsTheTurnIsNotAResult: `cancelled` and `refusal` are turns
// that did not happen. A result event saying `is_error: false` would finalize
// the stream as if the agent had answered, and the console would draw a
// finished turn where nothing was finished.
func TestAnAgentThatStopsTheTurnIsNotAResult(t *testing.T) {
	a := newAgent(t, "stops_cancelled", nil)
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	payload := payloadOf(t, findEvent(t, events, "result"))
	if payload["is_error"] != true {
		t.Fatalf("a turn the agent stopped reads as an answer: %v", payload)
	}
	if payload["stop_reason"] != "cancelled" {
		t.Fatalf("the reason the agent gave was lost: %v", payload)
	}
	if message, _ := payload["error"].(string); message == "" {
		t.Fatalf("the turn failed without saying why: %v", payload)
	}
}

// TestAnAgentThatDiesMidTurnIsAnError: the engine reads the terminal event out
// of the stream, so a stream that just ends has to say so.
func TestAnAgentThatDiesMidTurnIsAnError(t *testing.T) {
	a := newAgent(t, "die_mid_turn", nil)
	handle := a.start(t, adapter.TaskSpec{})
	events := collectEvents(t, handle, 10*time.Second)

	message, _ := payloadOf(t, findEvent(t, events, "error"))["message"].(string)
	if !strings.Contains(message, "exited") {
		t.Fatalf("error = %q", message)
	}
	exitCoder, ok := handle.(interface{ ExitCode() *int })
	if !ok {
		t.Fatal("the handle does not expose the agent's exit code")
	}
	if code := exitCoder.ExitCode(); code == nil || *code != 7 {
		t.Fatalf("exit code = %v, want 7", code)
	}
}

// TestAnAgentThatSpeaksAnotherVersionIsRefused: the protocol has no downgrade
// path, so a mismatch is an error at the start of the turn rather than a
// session that half works.
func TestAnAgentThatSpeaksAnotherVersionIsRefused(t *testing.T) {
	a := newAgent(t, "speak_v2", nil)
	events := collectEvents(t, a.start(t, adapter.TaskSpec{}), 10*time.Second)

	message, _ := payloadOf(t, findEvent(t, events, "error"))["message"].(string)
	if !strings.Contains(message, "version 2") || !strings.Contains(message, "speaks 1") {
		t.Fatalf("error = %q", message)
	}
	if len(a.log.inbound(t, methodSessionNew)) != 0 {
		t.Fatal("a session was opened with an agent Kin cannot talk to")
	}
}

// TestProviderKeysAreNotRoutedIntoAnAgent: an ACP agent authenticates itself
// (ADR 0022 D7). A resolved provider key on the task is a sign the routing layer
// has the wrong idea about this agent, and running anyway would hand a
// credential to a process that has no use for it.
func TestProviderKeysAreNotRoutedIntoAnAgent(t *testing.T) {
	a := newAgent(t, "updates", nil)
	_, err := a.adapter.Start(context.Background(), adapter.TaskSpec{
		ID: "task-1", Agent: "acp", Cwd: t.TempDir(), Prompt: "hi",
		ProviderCfg: &adapter.ProviderConfig{Kind: "openai-compatible", APIKey: "sk-secret"},
	})
	if err == nil {
		t.Fatal("a provider key was routed into an ACP agent")
	}
	if !strings.Contains(err.Error(), "authentication") {
		t.Fatalf("error = %v", err)
	}
	if a.log.read(t) != "" {
		t.Fatalf("the agent was started anyway:\n%s", a.log.read(t))
	}
}

func TestAMissingBinaryIsAnErrorAtStart(t *testing.T) {
	ad := &Adapter{Binary: "kin-there-is-no-such-agent"}
	if _, err := ad.Start(context.Background(), adapter.TaskSpec{ID: "task-1", Prompt: "hi"}); err == nil {
		t.Fatal("starting a missing agent reported no error")
	}
	if _, err := exec.LookPath("kin-there-is-no-such-agent"); err == nil {
		t.Skip("this machine has a binary by that name")
	}
}

func indexOf(values []string, want string) int {
	for i, value := range values {
		if value == want {
			return i
		}
	}
	return -1
}

// bridge sanity: the adapter and the bridge must agree on what a request with
// no daemon means, since that is the path every local-only run takes.
func TestABridgeWithoutADaemonIsStillABridge(t *testing.T) {
	var bridge *approvalBridge = newApprovalBridge(&approvalbridge.Client{}, adapter.TaskSpec{ID: "task-1"})
	response, recorded := bridge.requestPermission(context.Background(), question(optAllowOnce))
	if response.Outcome.Outcome != "cancelled" {
		t.Fatalf("outcome = %+v", response.Outcome)
	}
	if recorded {
		t.Fatal("a question no inbox ever saw was reported as recorded")
	}
}
