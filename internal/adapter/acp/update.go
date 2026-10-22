package acp

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/adapter"
)

// Session update kinds (`sessionUpdate` discriminator).
//
// The first eleven are the values the stable v1 schema defines. The last three
// are defined by newer schema revisions and gated behind client capabilities
// that Kin does not advertise; they are mapped anyway so that an agent which
// sends one is understood rather than silently dropped, and any kind at all
// that is not here is ignored without error — the protocol requires unknown
// updates to be tolerated.
const (
	updateUserMessageChunk     = "user_message_chunk"
	updateAgentMessageChunk    = "agent_message_chunk"
	updateAgentThoughtChunk    = "agent_thought_chunk"
	updateToolCall             = "tool_call"
	updateToolCallUpdate       = "tool_call_update"
	updatePlan                 = "plan"
	updateAvailableCommands    = "available_commands_update"
	updateCurrentMode          = "current_mode_update"
	updateConfigOption         = "config_option_update"
	updateSessionInfo          = "session_info_update"
	updateUsage                = "usage_update"
	updateNotice               = "notice"
	updateCompaction           = "compaction_update"
	updateCompactionChunk      = "compaction_summary_chunk"
	toolStatusCompleted        = "completed"
	toolStatusFailed           = "failed"
	toolStatusPending          = "pending"
	toolStatusInProgress       = "in_progress"
	messageRoleReasoning       = "reasoning"
	messagePhaseProgress       = "progress"
	messagePhaseCompaction     = "compaction"
	rawOutputStreamName        = "acp"
	maxToolOutputBytes         = 64 * 1024
	maxNoticeTextBytes         = 8 * 1024
	updateKindField            = sessionUpdateK
	fallbackUnknownUpdateLabel = "session update"
)

// contentBlock is the subset of ACP's ContentBlock Kin renders.
//
// Text is the baseline every agent must support; images, audio and embedded
// resources are carried through as raw output instead of being dropped, so the
// transcript shows that something arrived even though this console cannot draw
// it yet.
type contentBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	MimeType string          `json:"mimeType"`
	Data     string          `json:"data"`
	URI      string          `json:"uri"`
	Resource json.RawMessage `json:"resource"`
}

// contentChunk is the payload of the three streaming update kinds.
type contentChunk struct {
	Content   contentBlock `json:"content"`
	MessageID string       `json:"messageId"`
}

type toolCall struct {
	ToolCallID string          `json:"toolCallId"`
	Title      string          `json:"title"`
	Kind       string          `json:"kind"`
	Status     string          `json:"status"`
	RawInput   json.RawMessage `json:"rawInput"`
	RawOutput  json.RawMessage `json:"rawOutput"`
	Content    []toolContent   `json:"content"`
	Locations  []struct {
		Path string `json:"path"`
		Line *int   `json:"line"`
	} `json:"locations"`
}

// toolContent is one item of a tool call's output: a content block, a file
// diff, or a reference to a terminal Kin never created.
type toolContent struct {
	Type    string       `json:"type"`
	Content contentBlock `json:"content"`
	Path    string       `json:"path"`
	OldText *string      `json:"oldText"`
	NewText string       `json:"newText"`
}

type planUpdate struct {
	Entries []struct {
		Content  string `json:"content"`
		Priority string `json:"priority"`
		Status   string `json:"status"`
	} `json:"entries"`
}

type usageUpdate struct {
	Used int `json:"used"`
	Size int `json:"size"`
	Cost *struct {
		Amount   float64 `json:"amount"`
		Currency string  `json:"currency"`
	} `json:"cost"`
}

// mapUpdate turns one session/update into the Kin events it stands for.
//
// A single update maps to at most one event. Unknown or malformed updates
// produce no events and no error: an agent sending something this client does
// not model is a compatibility question, not a failed turn.
func mapUpdate(update json.RawMessage) []adapter.Event {
	var head struct {
		Kind string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(update, &head); err != nil {
		return nil
	}
	switch head.Kind {
	case updateUserMessageChunk:
		return chunkEvents(update, "user", "")
	case updateAgentMessageChunk:
		return chunkEvents(update, "assistant", "")
	case updateAgentThoughtChunk:
		// Reasoning is `role: "reasoning"` + `phase: "progress"`, the shape the
		// rest of Kin uses for it (kinagent, codex). Not a phase of its own: the
		// console decides where a message goes from its role and phase, and a
		// phase it has never heard of leaves the agent's private reasoning drawn
		// as its answer — the last thought of a turn would be the reply.
		return chunkEvents(update, messageRoleReasoning, messagePhaseProgress)
	case updateCompactionChunk:
		return chunkEvents(update, "assistant", messagePhaseCompaction)
	case updateToolCall:
		return toolCallEvents(update)
	case updateToolCallUpdate:
		return toolCallUpdateEvents(update)
	case updatePlan:
		return planEvents(update)
	case updateUsage:
		return usageEvents(update)
	case updateSessionInfo:
		return sessionInfoEvents(update)
	case updateAvailableCommands:
		return noticeEvents(update, "available commands", "the agent's command list changed")
	case updateCurrentMode:
		return noticeEvents(update, "mode changed", "")
	case updateConfigOption:
		return noticeEvents(update, "settings changed", "")
	case updateNotice:
		return noticeEvents(update, "", "")
	case updateCompaction:
		return noticeEvents(update, "context compacted", "")
	default:
		return nil
	}
}

// chunkEvents maps a streamed content block to a message event.
//
// The payload is the canonical shape every other adapter emits — a content
// block array — because that is what the console reads text out of: a flat
// `text` field is decoded by the engine but renders as nothing at all, which
// would make an ACP agent's answers invisible.
func chunkEvents(raw json.RawMessage, role, phase string) []adapter.Event {
	var chunk contentChunk
	if err := json.Unmarshal(raw, &chunk); err != nil {
		return nil
	}
	if chunk.Content.Type != "text" {
		return rawContentEvents(raw)
	}
	payload := map[string]any{
		"role":    role,
		"content": []map[string]string{{"type": "text", "text": chunk.Content.Text}},
		"partial": true,
	}
	if phase != "" {
		payload["phase"] = phase
	}
	if chunk.MessageID != "" {
		payload["message_id"] = chunk.MessageID
	}
	return []adapter.Event{{Type: "message", Payload: mustMarshal(payload)}}
}

// rawContentEvents records content this console cannot render, rather than
// dropping it: a turn whose transcript jumps from prompt to answer, with no
// sign that an image was sent, is harder to explain than one line saying so.
func rawContentEvents(raw json.RawMessage) []adapter.Event {
	return []adapter.Event{{
		Type:    "raw_output",
		Payload: mustMarshal(map[string]any{"line": string(raw), "stream": rawOutputStreamName}),
	}}
}

// toolCallEvents maps a new tool call to the Kin event the console merges into
// a step.
func toolCallEvents(raw json.RawMessage) []adapter.Event {
	var call toolCall
	if err := json.Unmarshal(raw, &call); err != nil || strings.TrimSpace(call.ToolCallID) == "" {
		return rawContentEvents(raw)
	}
	payload := toolPayload(call)
	if len(call.Content) == 0 {
		return []adapter.Event{{Type: "tool_use", Payload: mustMarshal(payload)}}
	}
	// An agent may send the call and its output in one update. The console
	// merges by tool_use_id, so both events are emitted in order.
	events := []adapter.Event{{Type: "tool_use", Payload: mustMarshal(payload)}}
	if output := toolOutput(call.Content); output != "" {
		events = append(events, adapter.Event{Type: "tool_result", Payload: mustMarshal(map[string]any{
			"tool_use_id": call.ToolCallID,
			"name":        toolName(call),
			"ok":          call.Status != toolStatusFailed,
			"output":      output,
		})})
	}
	return events
}

// toolCallUpdateEvents maps a patch to a tool call.
//
// Every field but the id is optional, so a patch that carries nothing Kin
// displays produces nothing. A patch that reports a terminal status becomes the
// matching tool_result, which is what closes the step in the console; the
// design sketch mapped both kinds to tool_use, but the console merges steps by
// pairing tool_use with tool_result, and a step that never closes reads as a
// hung turn.
func toolCallUpdateEvents(raw json.RawMessage) []adapter.Event {
	var update toolCall
	if err := json.Unmarshal(raw, &update); err != nil || strings.TrimSpace(update.ToolCallID) == "" {
		return rawContentEvents(raw)
	}
	output := toolOutput(update.Content)
	if update.Status == toolStatusCompleted || update.Status == toolStatusFailed {
		return []adapter.Event{{Type: "tool_result", Payload: mustMarshal(map[string]any{
			"tool_use_id": update.ToolCallID,
			"name":        toolName(update),
			"ok":          update.Status != toolStatusFailed,
			"output":      firstNonEmpty(output, rawString(update.RawOutput)),
		})}}
	}
	payload := toolPayload(update)
	if update.Status == toolStatusPending || update.Status == toolStatusInProgress {
		payload["status"] = update.Status
	}
	return []adapter.Event{{Type: "tool_use", Payload: mustMarshal(payload)}}
}

// toolPayload is the console's tool_use shape: a name to show, the input to
// expand, and one line of summary for the collapsed step.
func toolPayload(call toolCall) map[string]any {
	name := toolName(call)
	payload := map[string]any{
		"tool_use_id": call.ToolCallID,
		"name":        name,
		"summary":     name,
	}
	if len(call.RawInput) > 0 && string(call.RawInput) != "null" {
		payload["input"] = call.RawInput
	}
	for _, location := range call.Locations {
		if strings.TrimSpace(location.Path) != "" {
			payload["path"] = location.Path
			break
		}
	}
	return payload
}

// toolName is what to call a tool: the agent's own title, since ACP has no
// stable tool-name field, then its kind, then a word that says only that
// something ran.
func toolName(call toolCall) string {
	if title := strings.TrimSpace(call.Title); title != "" {
		return title
	}
	if kind := strings.TrimSpace(call.Kind); kind != "" {
		return kind
	}
	return "tool"
}

// toolOutput renders what a tool produced as text.
func toolOutput(content []toolContent) string {
	var parts []string
	for _, item := range content {
		switch item.Type {
		case "content":
			if item.Content.Type == "text" && item.Content.Text != "" {
				parts = append(parts, item.Content.Text)
			}
		case "diff":
			parts = append(parts, diffSummary(item))
		}
	}
	return truncateText(strings.Join(parts, "\n"), maxToolOutputBytes)
}

func diffSummary(item toolContent) string {
	var b strings.Builder
	b.WriteString("--- ")
	b.WriteString(item.Path)
	b.WriteString("\n")
	if item.OldText != nil {
		b.WriteString(strings.TrimRight(*item.OldText, "\n"))
		b.WriteString("\n")
	}
	b.WriteString("+++ ")
	b.WriteString(item.Path)
	b.WriteString("\n")
	b.WriteString(strings.TrimRight(item.NewText, "\n"))
	return b.String()
}

// planEvents maps a plan. Each update carries a whole `Plan` — the schema's
// `SessionUpdate` variant for `plan` is a `$ref` to `Plan`, whose own description
// is "Plans can evolve during execution as the agent discovers new requirements
// or completes tasks" — so Kin reads it as the current plan and says so with
// `replaces`. The console rewrites its plan line on every `plan` event, whether
// or not it reads that flag; the flag is there for a consumer that keeps more
// than one plan on screen and has to know this one is not a revision.
func planEvents(raw json.RawMessage) []adapter.Event {
	var plan planUpdate
	if err := json.Unmarshal(raw, &plan); err != nil {
		return nil
	}
	entries := make([]map[string]any, 0, len(plan.Entries))
	for _, entry := range plan.Entries {
		entries = append(entries, map[string]any{
			"content":  entry.Content,
			"status":   entry.Status,
			"priority": entry.Priority,
		})
	}
	return []adapter.Event{{Type: "plan", Payload: mustMarshal(map[string]any{
		"entries":  entries,
		"replaces": true,
	})}}
}

// usageEvents maps ACP's context-window report.
//
// `used` and `size` are context occupancy, not billing: they are reported under
// their own names so nothing downstream can mistake them for input tokens.
//
// A context update is a status line, never a Kin `usage` event. Two reasons,
// both from the schema:
//
//   - `cost.amount` is "total cumulative cost for session", and a Kin usage
//     event is incremental. Booking a running total once per update — and once
//     more on every `session/load`, which reports the whole session again —
//     inflates the ledger by more the longer a session runs.
//   - A usage event is a turn's accounting source: the engine books the tokens
//     that arrive with the prompt response only when the turn emitted no usage
//     event of its own. So a cost booked here would quietly cost the turn its
//     own numbers, whatever they are worth.
//
// Kin therefore shows what the agent reported and bills none of it. The same
// goes for the prompt response's own `usage`, whose scope upstream has not
// settled (see finishTurn): an ACP turn's numbers are read, not recorded.
func usageEvents(raw json.RawMessage) []adapter.Event {
	var usage usageUpdate
	if err := json.Unmarshal(raw, &usage); err != nil {
		return nil
	}
	return []adapter.Event{{Type: "notice", Payload: mustMarshal(usageNotice(usage))}}
}

// usageNotice is that status line: the occupancy, and the session's cost in the
// currency the agent named it in.
func usageNotice(usage usageUpdate) map[string]any {
	message := fmt.Sprintf("%d of %d", usage.Used, usage.Size)
	payload := map[string]any{
		"severity":     "info",
		"title":        "context used",
		"message":      message,
		"kind":         updateUsage,
		"context_used": usage.Used,
		"context_size": usage.Size,
	}
	if usage.Cost != nil {
		payload["message"] = fmt.Sprintf("%s · %g %s this session", message, usage.Cost.Amount,
			strings.ToUpper(strings.TrimSpace(usage.Cost.Currency)))
		payload["cost_amount"] = usage.Cost.Amount
		payload["cost_currency"] = usage.Cost.Currency
		// Named so nothing downstream can read the number as this turn's bill.
		payload["cost_scope"] = "session"
	}
	return payload
}

// reportedUsageNotice is what the agent said a turn cost, as a status line.
//
// The numbers are the agent's own and Kin does not record them (finishTurn has
// the schema quotes and the reasoning). Named `reported_*` so a later reader
// cannot mistake them for booked ones. Returns nil when the agent reported
// nothing worth reading, so an empty report does not become a line in the
// transcript.
func reportedUsageNotice(usage *promptUsage) map[string]any {
	if !usageReportsNumbers(usage) {
		return nil
	}
	detail := fmt.Sprintf("%d in / %d out", usage.InputTokens, usage.OutputTokens)
	if n := valueOrZero(usage.ThoughtTokens); n > 0 {
		detail += fmt.Sprintf(" / %d reasoning", n)
	}
	if n := valueOrZero(usage.CachedReadTokens); n > 0 {
		detail += fmt.Sprintf(" / %d cached read", n)
	}
	if n := valueOrZero(usage.CachedWriteTokens); n > 0 {
		detail += fmt.Sprintf(" / %d cached write", n)
	}
	if n := usage.TotalTokens; n > 0 {
		detail += fmt.Sprintf(" / %d total", n)
	}
	payload := map[string]any{
		"severity": "info",
		"title":    "usage reported",
		"kind":     updateUsage,
		"message": fmt.Sprintf("%s, as the agent reported it: ACP does not define whether that "+
			"covers this turn or the whole session, so Kin records nothing", detail),
		"reported_input_tokens":  usage.InputTokens,
		"reported_output_tokens": usage.OutputTokens,
	}
	if usage.TotalTokens != 0 {
		payload["reported_total_tokens"] = usage.TotalTokens
	}
	if usage.CachedReadTokens != nil {
		payload["reported_cache_read_tokens"] = *usage.CachedReadTokens
	}
	if usage.CachedWriteTokens != nil {
		payload["reported_cache_write_tokens"] = *usage.CachedWriteTokens
	}
	if usage.ThoughtTokens != nil {
		payload["reported_reasoning_tokens"] = *usage.ThoughtTokens
	}
	return payload
}

// usageReportsNumbers is the guard that keeps an empty report out of the
// transcript, and it counts every field the notice above can carry: an agent
// that reports only cache reads has reported something, and a guard that looked
// at the token totals alone would drop the line while the payload it never built
// was the only place those numbers could have appeared.
func usageReportsNumbers(usage *promptUsage) bool {
	if usage == nil {
		return false
	}
	return usage.InputTokens != 0 || usage.OutputTokens != 0 || usage.TotalTokens != 0 ||
		valueOrZero(usage.ThoughtTokens) != 0 || valueOrZero(usage.CachedReadTokens) != 0 ||
		valueOrZero(usage.CachedWriteTokens) != 0
}

func valueOrZero(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// sessionInfoEvents records the agent's own name for this session.
//
// It is a notice rather than a task rename: `tasks.title` is set from the prompt
// (or from Kin's summarizer), and there is no event-driven path to change it.
// Inventing one here would put a second writer on a field the console already
// shows, for a string the user typed themselves a moment earlier.
func sessionInfoEvents(raw json.RawMessage) []adapter.Event {
	var info struct {
		Title     string `json:"title"`
		UpdatedAt string `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &info); err != nil || strings.TrimSpace(info.Title) == "" {
		return nil
	}
	return []adapter.Event{{Type: "notice", Payload: mustMarshal(map[string]any{
		"severity": "info",
		"kind":     updateSessionInfo,
		"message":  info.Title,
	})}}
}

// noticeEvents records a status line the agent sent.
func noticeEvents(raw json.RawMessage, fallbackTitle, fallbackMessage string) []adapter.Event {
	var notice struct {
		Severity    string `json:"severity"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Message     string `json:"message"`
		Text        string `json:"text"`
	}
	if err := json.Unmarshal(raw, &notice); err != nil {
		return nil
	}
	title := firstNonEmpty(notice.Title, fallbackTitle)
	message := firstNonEmpty(notice.Description, notice.Message, notice.Text, fallbackMessage)
	if title == "" && message == "" {
		return nil
	}
	return []adapter.Event{{Type: "notice", Payload: mustMarshal(map[string]any{
		"severity": firstNonEmpty(notice.Severity, "info"),
		"title":    title,
		"message":  truncateText(message, maxNoticeTextBytes),
	})}}
}

// rawString renders a raw JSON value as text, for output an agent sent as a
// string and for anything else as its JSON form.
func rawString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// truncateText shortens text to a byte budget without cutting a rune in half:
// this is tool output and diff text, which is full of things that are not ASCII
// — half a character reads as mojibake where the rest was legible.
func truncateText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := value[:limit]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r != utf8.RuneError || size > 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut + "…"
}
