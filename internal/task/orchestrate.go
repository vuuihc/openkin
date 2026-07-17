package task

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/sessionctx"
	"github.com/vuuihc/kin/internal/store"
)

// shouldOrchestrate reports whether this run should fan out to sub-agents
// under a user-facing main agent instead of a single adapter turn.
//
// Triggers: explicit @worker mentions in the *current user message only*.
// Prior-context / handoff wrappers must not re-trigger multi-agent mode.
// Bare programming tasks stay on Kin, which has its own tool agent loop.
func (e *Engine) shouldOrchestrate(t store.Task) (DelegatePlan, bool) {
	avail := AvailableSet(e.AgentIDs())
	// Only the live user turn decides orchestration — strip any engine-injected
	// handoff wrapper so historical @mentions in prior context cannot fan out again.
	userTurn := UserTurnPrompt(t.Prompt)
	plan := ParseDelegatePlan(userTurn, avail)
	if plan.HasSubAgents() {
		var steps []DelegateStep
		for _, s := range plan.SubSteps() {
			if _, ok := e.adapters[s.Agent]; ok {
				steps = append(steps, s)
			}
		}
		if len(steps) > 0 {
			plan.Steps = steps
			// Keep overview from the current turn only.
			plan.Raw = userTurn
			// Carry transcript from the handoff wrapper so workers see prior turns.
			plan.SessionContext = ExtractPriorContext(t.Prompt)
			return plan, true
		}
	}
	return DelegatePlan{}, false
}

// isChatHost is true for agents that do not themselves provide a full coding
// agent loop (today: kin). Coding CLIs are not chat hosts for this purpose.
func (e *Engine) isChatHost(agentID string) bool {
	if agentID == "kin" {
		return true
	}
	// Unknown / empty treated as host only if no coding adapter matches.
	for _, id := range codingAgentOrder {
		if agentID == id {
			return false
		}
	}
	return agentID == "" || agentID == "kin"
}

// MainAgent is the user-facing host for orchestration and default chat.
// Prefer Kin when the cognition provider is registered; otherwise first default CLI.
func (e *Engine) MainAgent() string {
	if e.HasAgent("kin") {
		return "kin"
	}
	return e.DefaultAgent()
}

// runOrchestrated keeps a user-facing main agent, runs workers (parallel when
// independent), and stamps events with speaker/agent for the chat UI.
// Sub-agents only receive task briefs — they are not conversational peers.
func (e *Engine) runOrchestrated(id string, t store.Task, plan DelegatePlan) {
	ctx := e.ctx
	main := t.Agent
	if main == "" {
		main = e.MainAgent()
	}
	if main == "" {
		main = "kin"
	}

	waves := PlanWaves(plan.Steps)
	parallelN := 0
	for _, w := range waves {
		if len(w) > 1 {
			parallelN++
		}
	}

	// Short user-facing plan (no sysprompt-like boilerplate).
	var b strings.Builder
	b.WriteString("委派 ")
	for i, s := range plan.Steps {
		if i > 0 {
			b.WriteString(" · ")
		}
		fmt.Fprintf(&b, "**%s**", displayAgentName(s.Agent))
	}
	if parallelN > 0 {
		fmt.Fprintf(&b, "（%d 波次，可并行）", len(waves))
	} else if len(plan.Steps) > 1 {
		b.WriteString("（串行）")
	}
	b.WriteString("\n")
	for i, s := range plan.Steps {
		fmt.Fprintf(&b, "%d. %s — %s\n", i+1, displayAgentName(s.Agent), truncate(s.Instruction, 160))
	}
	e.emitSpeakerMessage(ctx, id, main, "assistant", strings.TrimSpace(b.String()), "orchestrator")

	// priorResults keyed by step index; filled as waves complete.
	priorByStep := make([]string, len(plan.Steps))
	failedByStep := make([]bool, len(plan.Steps))
	anyErr := false

	for wi, wave := range waves {
		// Collect completed prior text for dependent briefs.
		var priorList []string
		for si, txt := range priorByStep {
			if strings.TrimSpace(txt) != "" {
				priorList = append(priorList, fmt.Sprintf("[%s]\n%s", displayAgentName(plan.Steps[si].Agent), txt))
			}
		}

		// Brief wave marker (user-facing).
		if len(wave) == 1 {
			si := wave[0]
			step := plan.Steps[si]
			announce := fmt.Sprintf("→ **%s**（%d/%d）",
				displayAgentName(step.Agent), si+1, len(plan.Steps))
			e.emitSpeakerMessage(ctx, id, main, "assistant", announce, "delegate")
		} else {
			names := make([]string, 0, len(wave))
			for _, si := range wave {
				names = append(names, displayAgentName(plan.Steps[si].Agent))
			}
			announce := fmt.Sprintf("→ 并行 **%s**（波次 %d/%d）",
				strings.Join(names, " + "), wi+1, len(waves))
			e.emitSpeakerMessage(ctx, id, main, "assistant", announce, "delegate")
		}

		type stepOut struct {
			idx  int
			text string
			err  bool
		}
		outs := make([]stepOut, len(wave))
		var wg sync.WaitGroup
		var handles []adapter.RunHandle

		// Start all workers in the wave.
		for i, si := range wave {
			step := plan.Steps[si]
			ad := e.adapters[step.Agent]
			if ad == nil {
				e.emitError(ctx, id, fmt.Sprintf("Agent %s is not available", step.Agent))
				outs[i] = stepOut{idx: si, err: true}
				anyErr = true
				continue
			}
			brief := buildWorkerBrief(plan, step, priorList, si+1, len(plan.Steps))
			model := ""
			if t.Model != nil {
				model = *t.Model
			}
			// ID must be the real parent task id: Claude Code's approve-mcp
			// posts KIN_TASK_ID to POST /internal/approvals, which looks up
			// the tasks row. A synthetic "parent:agent:idx" id fails that
			// lookup and fail-closes as "denied via Kin console".
			spec := adapter.TaskSpec{
				ID:             t.ID,
				Agent:          step.Agent,
				Cwd:            t.Cwd,
				Prompt:         brief,
				Model:          model,
				SessionRef:     "",
				PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
			}
			h, err := ad.Start(ctx, spec)
			if err != nil {
				e.emitError(ctx, id, fmt.Sprintf("%s failed to start: %v", step.Agent, err))
				outs[i] = stepOut{idx: si, err: true}
				anyErr = true
				continue
			}
			handles = append(handles, h)
			outs[i] = stepOut{idx: si} // placeholder; filled by goroutine

			// Capture indices / step data for goroutine (incl. meta-output retry).
			gi, gsi, gagent, gh := i, si, step.Agent, h
			gstep := step
			gmodel := model
			gad := ad
			gprior := append([]string(nil), priorList...)
			wg.Add(1)
			go func() {
				defer wg.Done()
				text, failed := e.forwardWorkerEvents(ctx, id, gagent, gh)
				// Workers sometimes leak role/meta chatter and end_turn without findings.
				// Retry once with a tighter brief; if still meta, mark failed so the
				// orchestrator does not present it as a successful answer.
				if !failed && isWorkerMetaOutput(text) {
					e.mu.Lock()
					canceled := e.canceled[id]
					e.mu.Unlock()
					if !canceled {
						retryNote := fmt.Sprintf("%s returned meta-only output; retrying once with a tighter brief", displayAgentName(gagent))
						e.emitSpeakerMessage(ctx, id, "kin", "assistant", retryNote, "orchestrator")
						retryBrief := buildWorkerBriefMode(plan, gstep, gprior, gsi+1, len(plan.Steps), true)
						// Keep assignment identity stable for approvals.
						spec := adapter.TaskSpec{
							ID:             id,
							Agent:          gagent,
							Cwd:            t.Cwd,
							Prompt:         retryBrief,
							Model:          gmodel,
							SessionRef:     "",
							PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
						}
						h2, err := gad.Start(ctx, spec)
						if err != nil {
							e.emitError(ctx, id, fmt.Sprintf("%s meta-retry failed to start: %v", gagent, err))
							failed = true
						} else {
							// Allow Cancel() during retry.
							e.mu.Lock()
							if e.handleGroups != nil {
								e.handleGroups[id] = append(e.handleGroups[id], h2)
							}
							e.handles[id] = h2
							e.mu.Unlock()
							text2, failed2 := e.forwardWorkerEvents(ctx, id, gagent, h2)
							text, failed = text2, failed2
						}
					}
				}
				if !failed && isWorkerMetaOutput(text) {
					failed = true
					// Keep a short diagnostic for the digest; do not paste the full meta monologue.
					snippet := truncate(strings.TrimSpace(text), 180)
					text = "worker returned meta-only output (suppressed as non-answer)"
					if snippet != "" {
						text += ": " + snippet
					}
				}
				outs[gi] = stepOut{idx: gsi, text: text, err: failed}
			}()
		}

		// Register handles so Cancel() can stop the wave.
		e.mu.Lock()
		if e.handleGroups == nil {
			e.handleGroups = make(map[string][]adapter.RunHandle)
		}
		e.handleGroups[id] = append([]adapter.RunHandle(nil), handles...)
		if len(handles) > 0 {
			e.handles[id] = handles[0]
		}
		canceled := e.canceled[id]
		e.mu.Unlock()

		if canceled {
			for _, h := range handles {
				_ = h.Cancel()
			}
			wg.Wait()
			e.clearHandleGroup(id)
			e.finishOrchestrated(ctx, id, true)
			return
		}

		wg.Wait()
		e.clearHandleGroup(id)

		e.mu.Lock()
		canceled = e.canceled[id]
		e.mu.Unlock()
		if canceled {
			e.finishOrchestrated(ctx, id, true)
			return
		}

		for _, o := range outs {
			if o.err {
				anyErr = true
				failedByStep[o.idx] = true
			}
			if strings.TrimSpace(o.text) != "" {
				priorByStep[o.idx] = o.text
			}
		}
	}

	// Build ordered prior list for summary (WorkerDigest — Policy C).
	var priorResults []string
	var priorFailed []bool
	for si, txt := range priorByStep {
		if strings.TrimSpace(txt) == "" && !failedByStep[si] {
			continue
		}
		label := displayAgentName(plan.Steps[si].Agent)
		priorResults = append(priorResults, fmt.Sprintf("[%s]\n%s", label, txt))
		priorFailed = append(priorFailed, failedByStep[si])
	}

	summary := buildMainSummary(plan, priorResults, priorFailed, anyErr)
	e.emitSpeakerMessage(ctx, id, main, "assistant", summary, "orchestrator")

	res, _ := json.Marshal(map[string]any{
		"source":   "orchestrator",
		"is_error": anyErr,
		"steps":    len(plan.Steps),
		"waves":    len(waves),
		"main":     main,
	})
	e.appendEventLocked(ctx, id, "result", res)

	e.finishOrchestrated(ctx, id, anyErr)
}

func (e *Engine) clearHandleGroup(id string) {
	e.mu.Lock()
	delete(e.handles, id)
	delete(e.handleGroups, id)
	e.mu.Unlock()
}

func (e *Engine) finishOrchestrated(ctx context.Context, id string, failed bool) {
	e.mu.Lock()
	wasCanceled := e.canceled[id]
	pf, hasFollowUp := e.pendingFollowUp[id]
	delete(e.handles, id)
	delete(e.handleGroups, id)
	delete(e.canceled, id)
	delete(e.pendingFollowUp, id)
	e.active--
	e.mu.Unlock()

	// Interrupted with a steerable follow-up: re-queue instead of staying canceled.
	if hasFollowUp {
		if _, err := e.applyPendingFollowUp(ctx, id, pf); err != nil {
			e.emitError(ctx, id, "follow-up after interrupt failed: "+err.Error())
			_, _ = e.finish(ctx, id, StatusFailed, nil, nil)
		}
		e.pump()
		return
	}

	if wasCanceled {
		_, _ = e.finish(ctx, id, StatusCanceled, nil, nil)
		e.pump()
		return
	}
	final := StatusSucceeded
	if failed {
		final = StatusFailed
	}
	_, _ = e.finish(ctx, id, final, nil, nil)
	e.pump()
}

// forwardWorkerEvents copies adapter events onto the parent task, stamping speaker.
// Safe for concurrent waves (serialized via eventMu).
func (e *Engine) forwardWorkerEvents(ctx context.Context, taskID, agent string, h adapter.RunHandle) (string, bool) {
	// Collect only final, user-facing findings for the orchestrator summary.
	// Process chatter (partials / intermediate tool narration) stays on the event
	// bus for the progress UI, but must not become the main-chat "结果".
	var finals []string
	var resultText string
	sawResult := false
	isErr := false

	for ev := range h.Events() {
		payload := stampWorker(ev.Payload, agent)
		e.appendEventLocked(ctx, taskID, ev.Type, payload)
		switch ev.Type {
		case "message":
			if t := extractFinalWorkerText(ev.Payload); t != "" {
				finals = append(finals, t)
			}
		case "result":
			sawResult = true
			isErr = resultIsError(ev.Payload)
			if t := extractResultText(ev.Payload); t != "" {
				resultText = t
			}
		case "error":
			isErr = true
		}

		e.mu.Lock()
		canceled := e.canceled[taskID]
		e.mu.Unlock()
		if canceled {
			_ = h.Cancel()
			return chooseWorkerSummary(resultText, finals), true
		}
	}
	if !sawResult {
		isErr = true
	}
	return chooseWorkerSummary(resultText, finals), isErr
}

// chooseWorkerSummary prefers the adapter's terminal result text (Claude Code
// puts the final answer on result.result). Falls back to non-partial messages.
func chooseWorkerSummary(resultText string, finals []string) string {
	if strings.TrimSpace(resultText) != "" {
		return strings.TrimSpace(resultText)
	}
	if len(finals) == 0 {
		return ""
	}
	// Last complete assistant message is usually the consolidated answer.
	return strings.TrimSpace(finals[len(finals)-1])
}

// extractFinalWorkerText returns text only from completed (non-partial)
// assistant messages. Streaming deltas and reasoning are ignored so the
// orchestrator summary does not replay the worker's thinking process.
func extractFinalWorkerText(raw json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	if partial, _ := m["partial"].(bool); partial {
		return ""
	}
	if role, _ := m["role"].(string); role == "reasoning" || role == "system" || role == "user" {
		return ""
	}
	return strings.TrimSpace(extractMessageText(m))
}

// extractResultText pulls a final answer string from a result event payload.
func extractResultText(raw json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	switch v := m["result"].(type) {
	case string:
		return strings.TrimSpace(v)
	case map[string]any:
		// Some adapters nest text under result.
		if t, ok := v["text"].(string); ok {
			return strings.TrimSpace(t)
		}
	}
	if t, ok := m["message"].(string); ok {
		// Error-ish results only — avoid treating generic status strings as answers.
		if isErr, _ := m["is_error"].(bool); isErr {
			return strings.TrimSpace(t)
		}
	}
	return ""
}

func (e *Engine) appendEventLocked(ctx context.Context, taskID, typ string, payload json.RawMessage) {
	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	stored, err := e.store.AppendEvent(ctx, taskID, typ, payload)
	if err == nil {
		e.bus.PublishEvent(stored)
	}
}

func (e *Engine) emitSpeakerMessage(ctx context.Context, taskID, agent, role, text, source string) {
	// Main-agent turns are user-facing; workers are task-only (see stampSpeaker).
	userFacing := source == "orchestrator" || source == "delegate" || agent == "kin"
	payload, _ := json.Marshal(map[string]any{
		"role":    role,
		"content": []map[string]string{{"type": "text", "text": text}},
		"partial": false,
		"agent":   agent,
		"speaker": agent,
		"source":  source,
		"visibility": map[string]bool{
			"user": userFacing,
			"task": !userFacing,
		},
	})
	e.appendEventLocked(ctx, taskID, "message", payload)
}

func (e *Engine) emitError(ctx context.Context, taskID, msg string) {
	payload, _ := json.Marshal(map[string]string{"message": msg})
	e.appendEventLocked(ctx, taskID, "error", payload)
}

// stampSpeaker tags events for the user-facing main agent / single-agent runs.
// Does not force task-only visibility (workers use stampWorker).
func stampSpeaker(raw json.RawMessage, agent string) json.RawMessage {
	return stampAgent(raw, agent, false)
}

// stampWorker tags sub-agent events as task-only (hidden from main chat column).
func stampWorker(raw json.RawMessage, agent string) json.RawMessage {
	return stampAgent(raw, agent, true)
}

func stampAgent(raw json.RawMessage, agent string, taskOnly bool) json.RawMessage {
	if len(raw) == 0 {
		m := map[string]any{"agent": agent, "speaker": agent, "source": agent}
		if taskOnly {
			m["visibility"] = map[string]bool{"user": false, "task": true}
		} else {
			m["visibility"] = map[string]bool{"user": true, "task": true}
		}
		b, _ := json.Marshal(m)
		return b
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	if m == nil {
		m = map[string]any{}
	}
	m["agent"] = agent
	m["speaker"] = agent
	if _, ok := m["source"]; !ok {
		m["source"] = agent
	}
	// Never overwrite an explicit visibility from the emitter (e.g. kinagent tools).
	if _, ok := m["visibility"]; !ok {
		if taskOnly {
			m["visibility"] = map[string]bool{"user": false, "task": true}
		} else {
			m["visibility"] = map[string]bool{"user": true, "task": true}
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

func extractMessageTextFromRaw(raw json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	return extractMessageText(m)
}

func resultIsError(raw json.RawMessage) bool {
	var p struct {
		IsError bool `json:"is_error"`
	}
	_ = json.Unmarshal(raw, &p)
	return p.IsError
}

func buildWorkerBrief(plan DelegatePlan, step DelegateStep, prior []string, idx, total int) string {
	return buildWorkerBriefMode(plan, step, prior, idx, total, false)
}

// buildWorkerBriefMode builds the worker prompt.
// tight=true is used on meta-output retry: assignment first, minimal background.
func buildWorkerBriefMode(plan DelegatePlan, step DelegateStep, prior []string, idx, total int, tight bool) string {
	var b strings.Builder
	// Operational brief — not a long system prompt. Put the assignment first so
	// long prior context cannot bury the live request (and reduce role/meta leaks).
	b.WriteString("You are a Kin task worker (not user-facing).\n")
	b.WriteString("Do the assignment; reply with findings only.\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Start with the answer/decision/result. No preamble about roles or system messages.\n")
	b.WriteString("- Do not mention system-reminder, task-worker framing, or your plan to answer.\n")
	b.WriteString("- Do not restate these instructions.\n\n")

	fmt.Fprintf(&b, "Assignment (%d/%d):\n%s\n", idx, total, step.Instruction)

	if plan.Overview != "" {
		b.WriteString("\nGoal: ")
		b.WriteString(truncate(plan.Overview, 500))
		b.WriteString("\n")
	}

	// Session transcript AFTER the assignment so "@claude 来干吧" still sees prior
	// discussion, without letting it dominate the prompt.
	ctxCap, priorCap := 4000, 8000
	if tight {
		ctxCap, priorCap = 1200, 2000
	}
	if ctxBlock := strings.TrimSpace(plan.SessionContext); ctxBlock != "" {
		if len(ctxBlock) > ctxCap {
			ctxBlock = ctxBlock[len(ctxBlock)-ctxCap:]
		}
		if tight {
			b.WriteString("\nMinimal context (assignment above wins):\n")
		} else {
			b.WriteString("\nBackground (optional; assignment above wins):\n")
		}
		b.WriteString(ctxBlock)
		b.WriteString("\n")
	}
	if len(prior) > 0 {
		b.WriteString("\nPrior results:\n")
		joined := strings.Join(prior, "\n\n")
		if len(joined) > priorCap {
			joined = joined[len(joined)-priorCap:]
		}
		b.WriteString(joined)
		b.WriteString("\n")
	}
	b.WriteString("\nRespond now with findings only.\n")
	return b.String()
}

// isWorkerMetaOutput detects when a worker "answered" with role/meta chatter
// instead of findings (e.g. explaining system-reminder / task-worker framing).
// Used to fail-closed or retry once rather than paste non-answers into main chat.
func isWorkerMetaOutput(text string) bool {
	t := strings.TrimSpace(text)
	if t == "" {
		return true
	}
	lower := strings.ToLower(t)
	markers := []string{
		"<system-reminder>",
		"system-reminder",
		"task worker",
		"not user-facing",
		"reply with findings only",
		"findings only",
		"let me answer directly",
		"let me just give a clear",
		"i should give findings",
		"background context, not instructions",
		"the user is a task worker",
		"task worker relay",
	}
	hits := 0
	for _, m := range markers {
		if strings.Contains(lower, m) {
			hits++
		}
	}
	if hits == 0 {
		return false
	}
	// Short replies dominated by meta phrases are non-answers.
	if utf8.RuneCountInString(t) < 800 {
		return true
	}
	// Longer text that still opens with role/meta chatter.
	prefix := lower
	if len(prefix) > 400 {
		prefix = prefix[:400]
	}
	for _, m := range []string{"system-reminder", "task worker", "let me answer", "findings only", "task worker relay"} {
		if strings.Contains(prefix, m) {
			return true
		}
	}
	return false
}

func buildMainSummary(plan DelegatePlan, prior []string, priorFailed []bool, anyErr bool) string {
	var b strings.Builder
	if anyErr {
		b.WriteString("完成（有失败）：\n\n")
	} else {
		b.WriteString("完成：\n\n")
	}
	if len(prior) == 0 {
		b.WriteString("_（无文本结果）_")
	} else {
		for i, p := range prior {
			if i > 0 {
				b.WriteString("\n\n---\n\n")
			}
			failed := false
			if i < len(priorFailed) {
				failed = priorFailed[i]
			}
			// Policy C: WorkerDigest before main context / main chat.
			// Full worker answer remains in task-only events.
			b.WriteString(sessionctx.WorkerDigest(p, failed))
		}
	}
	_ = plan // reserved for assignment one-liners in a later polish
	return strings.TrimSpace(b.String())
}

func displayAgentName(id string) string {
	switch id {
	case "claude-code":
		return "Claude Code"
	case "codex":
		return "Codex"
	case "grok":
		return "Grok"
	case "kin":
		return "Kin"
	default:
		return id
	}
}

func truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
