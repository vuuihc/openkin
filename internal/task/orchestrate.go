package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/routing"
	"github.com/vuuihc/openkin/internal/sessionctx"
	"github.com/vuuihc/openkin/internal/store"
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
	hostModel := ""
	if t.Model != nil {
		hostModel = strings.TrimSpace(*t.Model)
	}
	if plan.HasDelegateWorkers(t.Agent, hostModel) {
		var steps []DelegateStep
		planN := len(plan.Steps)
		for _, s := range plan.SubSteps() {
			// Bare @host (same model) is redundant routing, not a second worker.
			// Same agent with an explicit different model is a model-switch worker.
			// Multiple @host steps are a same-agent work split inside this task.
			if !isDelegateWorkerStep(s, t.Agent, hostModel, planN) {
				continue
			}
			if e.HasAgent(s.Agent) {
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

// runOrchestrated keeps a user-facing main agent, runs workers (parallel when
// independent), and stamps events with speaker/agent for the chat UI.
// Sub-agents only receive task briefs — they are not conversational peers.
func (e *Engine) runOrchestrated(
	id string,
	t store.Task,
	plan DelegatePlan,
	runMeta adapter.RunMetadata,
) {
	ctx := e.ctx
	executionID := runMeta.WorkspaceExecutionID
	main := t.Agent
	if main == "" {
		main = e.DefaultAgentContext(ctx)
	}

	hostModel := ""
	if t.Model != nil {
		hostModel = strings.TrimSpace(*t.Model)
	}
	if e.hostHasOrchestrate(main) {
		refined, usage, ok := e.tryHostPlanRefine(ctx, main, hostModel, plan)
		e.recordControllerUsage(ctx, id, executionID, main, "orchestration_plan", usage)
		if ok {
			plan = refined
		} else {
			e.emitOrchestrationFallback(ctx, id, executionID, main, "plan refine unavailable or invalid", "plan")
		}
	}
	if !e.isActiveRun(id, executionID) {
		e.finishOrchestrated(ctx, id, executionID, true)
		return
	}
	if workerPlanNeedsWrite(plan) && runMeta.WorkspaceAccess == adapter.AccessSourceReadOnly {
		var err error
		t, runMeta, err = e.promoteWorkerWorkspace(ctx, t, executionID, runMeta)
		if err != nil {
			e.emitError(ctx, id, executionID, "prepare writable worker workspace failed: "+err.Error())
			e.finishOrchestrated(ctx, id, executionID, true)
			return
		}
	}

	waves := PlanWaves(plan.Steps)
	if err := e.persistWorkerPlan(ctx, id, executionID, plan, waves); err != nil {
		e.emitError(ctx, id, executionID, "persist worker plan failed: "+err.Error())
		e.finishOrchestrated(ctx, id, executionID, true)
		return
	}
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
		fmt.Fprintf(&b, "**%s**", e.agentDisplayName(s.Agent, effectiveStepModel(t, s)))
	}
	if parallelN > 0 {
		fmt.Fprintf(&b, "（%d 波次，可并行）", len(waves))
	} else if len(plan.Steps) > 1 {
		b.WriteString("（串行）")
	}
	b.WriteString("\n")
	for i, s := range plan.Steps {
		fmt.Fprintf(&b, "%d. %s — %s\n", i+1, e.agentDisplayName(s.Agent, effectiveStepModel(t, s)), truncate(s.Instruction, 160))
	}
	e.emitSpeakerMessage(ctx, id, executionID, main, "assistant", strings.TrimSpace(b.String()), "orchestrator", "plan")

	// priorResults keyed by step index; filled as waves complete.
	priorByStep := make([]string, len(plan.Steps))
	failedByStep := make([]bool, len(plan.Steps))
	anyErr := false

	for wi, wave := range waves {
		if !e.isActiveRun(id, executionID) {
			e.finishOrchestrated(ctx, id, executionID, true)
			return
		}
		// Collect completed prior text for dependent briefs.
		var priorList []string
		for si, txt := range priorByStep {
			if strings.TrimSpace(txt) != "" {
				step := plan.Steps[si]
				priorList = append(priorList, fmt.Sprintf("[%s]\n%s", e.agentDisplayName(step.Agent, effectiveStepModel(t, step)), txt))
			}
		}

		// Brief wave marker (user-facing).
		if len(wave) == 1 {
			si := wave[0]
			step := plan.Steps[si]
			announce := fmt.Sprintf("→ **%s**（%d/%d）",
				e.agentDisplayName(step.Agent, effectiveStepModel(t, step)), si+1, len(plan.Steps))
			e.emitSpeakerMessage(ctx, id, executionID, main, "assistant", announce, "delegate", "progress")
		} else {
			names := make([]string, 0, len(wave))
			for _, si := range wave {
				step := plan.Steps[si]
				names = append(names, e.agentDisplayName(step.Agent, effectiveStepModel(t, step)))
			}
			announce := fmt.Sprintf("→ 并行 **%s**（波次 %d/%d）",
				strings.Join(names, " + "), wi+1, len(waves))
			e.emitSpeakerMessage(ctx, id, executionID, main, "assistant", announce, "delegate", "progress")
		}

		type stepOut struct {
			idx      int
			text     string
			err      bool
			errText  string
			canceled bool
		}
		outs := make([]stepOut, len(wave))
		var wg sync.WaitGroup
		var handles []adapter.RunHandle

		// Start all workers in the wave.
		for i, si := range wave {
			step := plan.Steps[si]
			brief := buildWorkerBrief(plan, step, priorList, si+1, len(plan.Steps))

			// Use fallback-aware start when routing metadata is present.
			h, execRef, failedProviders, err := e.startWorkerWithFallback(
				ctx, id, t, step, brief, si, workerRunMeta(runMeta, step),
			)
			if err != nil {
				e.emitError(ctx, id, executionID, fmt.Sprintf("%s failed to start: %v", step.Agent, err))
				e.updateWorkerStep(ctx, id, executionID, si, store.WorkerStepPatch{
					Status: workerStringPtr(StatusFailed),
					Error:  workerStringPtr(err.Error()),
				})
				outs[i] = stepOut{idx: si, err: true, errText: err.Error()}
				anyErr = true
				continue
			}
			if !e.registerWorkerStepHandle(id, executionID, si, h) {
				for _, started := range handles {
					_ = started.Cancel()
				}
				wg.Wait()
				e.finishOrchestrated(ctx, id, executionID, true)
				return
			}

			handles = append(handles, h)
			// Update step provider/model from the resolved fallback chain.
			if execRef.ProviderID != "" {
				step.Provider = execRef.ProviderID
			}
			if execRef.Model != "" {
				step.Model = execRef.Model
			}
			execJSON, _ := json.Marshal(execRef)
			attempt := len(failedProviders) + 1
			e.updateWorkerStep(ctx, id, executionID, si, store.WorkerStepPatch{
				Status:       workerStringPtr("running"),
				Attempt:      workerIntPtr(attempt),
				Provider:     workerStringPtr(step.Provider),
				Model:        workerStringPtr(execRef.Model),
				ExecutionRef: workerStringPtr(string(execJSON)),
			})
			outs[i] = stepOut{idx: si} // placeholder; filled by goroutine

			// Capture indices / step data for goroutine (incl. meta-output retry).
			gi, gsi, gagent, gh := i, si, step.Agent, h
			gstep := step
			gmodel := execRef.Model
			gad, _ := e.runnerFor(step.Agent)
			gprior := append([]string(nil), priorList...)
			gbrief := brief
			gexec := execRef
			gfailedProviders := failedProviders
			wg.Add(1)
			go func() {
				defer wg.Done()
				// Once this worker's stream ends it is no longer cancellable: a
				// reader's cancel that arrives now must not rewrite a step that has
				// already answered. The wave's terminal write still lands below.
				defer e.unregisterWorkerStepHandle(id, executionID, gsi)
				text, failed, failure := e.forwardWorkerEvents(
					ctx, id, executionID, gagent, gmodel, gexec, gh,
				)
				// A person stopping this worker closes its stream just like a crash
				// does. The mark is what tells the two apart; without it the retry
				// paths below would start the very step they just stopped.
				if e.workerStepCanceled(id, executionID, gsi) {
					outs[gi] = stepOut{idx: gsi, canceled: true}
					return
				}
				// Workers sometimes leak role/meta chatter and end_turn without findings.
				// Retry once with a tighter brief; if still meta, mark failed so the
				// orchestrator does not present it as a successful answer.
				if !failed && isWorkerMetaOutput(text) {
					e.mu.Lock()
					canceled := e.canceled[id]
					e.mu.Unlock()
					if !canceled && !e.workerStepCanceled(id, executionID, gsi) {
						retryNote := fmt.Sprintf("%s returned meta-only output; retrying once with a tighter brief", e.agentDisplayName(gagent, gmodel))
						e.emitSpeakerMessage(ctx, id, executionID, main, "assistant", retryNote, "orchestrator", "progress")
						retryBrief := buildWorkerBriefMode(plan, gstep, gprior, gsi+1, len(plan.Steps), true)
						// Parent task id stays stable for approval lookup; meta-retry
						// gets a fresh execution id so attribution distinguishes runs.
						retryExec := adapter.ExecutionRef{
							Agent:      gagent,
							Model:      gmodel,
							Step:       gsi + 1,
							ProviderID: gstep.Provider,
						}
						eid, err := e.newID()
						if err != nil {
							e.emitError(ctx, id, executionID, fmt.Sprintf("%s meta-retry execution id: %v", gagent, err))
							failed = true
						} else {
							retryExec.ID = eid
							if !e.runAcceptsWorker(id, executionID) {
								failed = true
								outs[gi] = stepOut{idx: gsi, text: text, err: true}
								return
							}
							spec := adapter.TaskSpec{
								ID:             id,
								Agent:          gagent,
								Cwd:            t.EffectiveCwd(),
								Prompt:         retryBrief,
								Model:          gmodel,
								SessionRef:     "",
								PermissionMode: adapter.NormalizePermissionMode(t.PermissionMode),
								Execution:      retryExec,
								RunMeta:        workerRunMeta(runMeta, gstep),
							}
							if cfg, err := e.resolveProviderCfg(ctx, retryExec.ProviderID); err == nil && cfg.BaseURL != "" {
								spec.ProviderCfg = &cfg
							}
							h2, err := gad.Start(ctx, spec)
							if err != nil {
								e.emitError(ctx, id, executionID, fmt.Sprintf("%s meta-retry failed to start: %v", gagent, err))
								failed = true
							} else {
								if !e.registerWorkerStepHandle(id, executionID, gsi, h2) {
									failed = true
									outs[gi] = stepOut{idx: gsi, text: text, err: true}
									return
								}
								retryJSON, _ := json.Marshal(retryExec)
								e.updateWorkerStep(ctx, id, executionID, gsi, store.WorkerStepPatch{
									Attempt:      workerIntPtr(2),
									Model:        workerStringPtr(gmodel),
									ExecutionRef: workerStringPtr(string(retryJSON)),
								})
								text2, failed2, _ := e.forwardWorkerEvents(
									ctx, id, executionID, gagent, gmodel, retryExec, h2,
								)
								if e.workerStepCanceled(id, executionID, gsi) {
									outs[gi] = stepOut{idx: gsi, canceled: true}
									return
								}
								text, failed = text2, failed2
							}
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
				// Runtime fallback: if the worker failed with a quota/rate-limit/transient
				// error and the step has routing metadata, retry with the next provider.
				// A step the reader stopped is not a candidate: its failure is the
				// cancel, and starting another provider would undo what they asked for.
				if failed && !e.workerStepCanceled(id, executionID, gsi) && routing.IsFallbackSafe(failure.Class) && gstep.Phase != "" && gstep.Provider != "" && e.routingResolver != nil {
					prev := routing.Decision{
						Agent:           gstep.Agent,
						Provider:        gstep.Provider,
						Model:           gmodel,
						Phase:           routing.RoutePhase(gstep.Phase),
						FailedProviders: gfailedProviders,
					}
					sel := parseDispatch(t.Dispatch)
					prev.Team = sel.Team
					prev.Objective = sel.Objective
					if prev.Objective == "" {
						prev.Objective = "balanced"
					}
					next, ok := e.routingResolver.Next(ctx, prev, failure)
					if ok {
						e.emitRouteFallbackForRun(ctx, id, executionID, failure, next)
						retryStep := gstep
						retryStep.Provider = next.Provider
						retryStep.Model = next.Model
						h2, exec2, fallbackFailures, err2 := e.startWorkerWithFallback(
							ctx, id, t, retryStep, gbrief, gsi, workerRunMeta(runMeta, retryStep),
						)
						if err2 == nil {
							if !e.registerWorkerStepHandle(id, executionID, gsi, h2) {
								outs[gi] = stepOut{idx: gsi, text: text, err: true}
								return
							}
							fallbackJSON, _ := json.Marshal(exec2)
							e.updateWorkerStep(ctx, id, executionID, gsi, store.WorkerStepPatch{
								Attempt:      workerIntPtr(2 + len(gfailedProviders) + len(fallbackFailures)),
								Provider:     workerStringPtr(exec2.ProviderID),
								Model:        workerStringPtr(exec2.Model),
								ExecutionRef: workerStringPtr(string(fallbackJSON)),
							})
							text2, failed2, _ := e.forwardWorkerEvents(
								ctx, id, executionID, gagent, exec2.Model, exec2, h2,
							)
							if e.workerStepCanceled(id, executionID, gsi) {
								outs[gi] = stepOut{idx: gsi, canceled: true}
								return
							}
							text, failed = text2, failed2
						} else {
							e.emitError(ctx, id, executionID, fmt.Sprintf("%s runtime fallback failed to start: %v", gagent, err2))
						}
					} else {
						// No fallback candidate available; apply terminal_limit_policy.
						defaults, defaultsErr := e.loadRoutingDefaults(ctx)
						if defaultsErr != nil {
							e.emitError(ctx, id, executionID, fmt.Sprintf("routing configuration failed: %v", defaultsErr))
							defaults = routing.DefaultRoutingDefaults()
						}
						switch defaults.TerminalLimitPolicy {
						case "wait":
							e.emitError(ctx, id, executionID, fmt.Sprintf("%s: all routing candidates exhausted; waiting for rate-limit window reset", gagent))
						case "ask":
							e.emitError(ctx, id, executionID, fmt.Sprintf("%s: all routing candidates exhausted; please choose a different provider/model manually", gagent))
						default:
							e.emitError(ctx, id, executionID, fmt.Sprintf("%s: all routing candidates exhausted", gagent))
						}
					}
				}
				outs[gi] = stepOut{idx: gsi, text: text, err: failed}
			}()
		}

		e.mu.Lock()
		canceled := e.canceled[id]
		e.mu.Unlock()

		if canceled {
			for _, h := range handles {
				_ = h.Cancel()
			}
			wg.Wait()
			e.clearHandleGroup(id, executionID)
			e.cancelWorkerSteps(ctx, id, executionID)
			e.finishOrchestrated(ctx, id, executionID, true)
			return
		}

		wg.Wait()
		e.clearHandleGroup(id, executionID)

		e.mu.Lock()
		canceled = e.canceled[id]
		e.mu.Unlock()
		if canceled {
			e.cancelWorkerSteps(ctx, id, executionID)
			e.finishOrchestrated(ctx, id, executionID, true)
			return
		}

		for _, o := range outs {
			// A step the reader stopped ended on purpose. Its cancel handler
			// already wrote the canceled row, so the wave must not replace it with
			// succeeded/failed, count a failure against the task, or hand a
			// half-finished answer to the summary as findings.
			if o.canceled || e.workerStepCanceled(id, executionID, o.idx) {
				continue
			}
			if o.err {
				anyErr = true
				failedByStep[o.idx] = true
			}
			if strings.TrimSpace(o.text) != "" {
				priorByStep[o.idx] = o.text
			}
			status := "succeeded"
			if o.err {
				status = StatusFailed
			}
			summary := o.text
			errText := ""
			if o.err {
				errText = o.errText
				if errText == "" {
					errText = "worker step failed"
				}
			}
			e.updateWorkerStep(ctx, id, executionID, o.idx, store.WorkerStepPatch{
				Status:        workerStringPtr(status),
				ResultSummary: workerStringPtr(truncate(summary, 2000)),
				Error:         workerStringPtr(errText),
			})
		}
	}

	// A plan whose every step the reader stopped has nothing to summarize, and
	// calling that a success would tell the reader -- and any automation reading
	// the status -- that work was delivered when the reader ended it.
	lang := responseLanguageForPrompt(UserTurnPrompt(t.Prompt))
	stopped := e.stoppedWorkerSteps(id, executionID, len(plan.Steps))
	if len(plan.Steps) > 0 && stopped == len(plan.Steps) {
		e.emitSpeakerMessage(ctx, id, executionID, main, "assistant",
			stoppedEverythingNote(lang, stopped), "orchestrator", "summary")
		e.finishOrchestratedCanceled(ctx, id, executionID)
		return
	}

	// Build ordered prior list for summary (WorkerDigest — Policy C).
	var priorResults []string
	var priorFailed []bool
	for si, txt := range priorByStep {
		if strings.TrimSpace(txt) == "" && !failedByStep[si] {
			continue
		}
		step := plan.Steps[si]
		label := e.agentDisplayName(step.Agent, effectiveStepModel(t, step))
		priorResults = append(priorResults, fmt.Sprintf("[%s]\n%s", label, txt))
		priorFailed = append(priorFailed, failedByStep[si])
	}

	summary := buildUserFacingSummary(UserTurnPrompt(t.Prompt), priorResults, priorFailed, anyErr)
	// Optional host control-plane synthesis when the plugin declares orchestrate.
	if e.hostHasOrchestrate(main) {
		var synthPrompt strings.Builder
		synthPrompt.WriteString("Write the final answer to the user. Be concise and factual.\n")
		synthPrompt.WriteString("Do not mention orchestration, workers, digests, prompts, handoffs, or internal task logs. Do not use headings such as Request, Worker, or Deliverable. State the result directly.\n\n")
		synthPrompt.WriteString("User request:\n")
		synthPrompt.WriteString(UserTurnPrompt(t.Prompt))
		synthPrompt.WriteString("\n\nWorker results:\n")
		for i, r := range priorResults {
			failed := i < len(priorFailed) && priorFailed[i]
			synthPrompt.WriteString(sessionctx.WorkerDigest(r, failed))
			synthPrompt.WriteString("\n---\n")
		}
		if anyErr {
			synthPrompt.WriteString("\nNote: at least one worker failed.\n")
		}
		if stopped > 0 {
			synthPrompt.WriteString("\nNote: the user stopped at least one worker, so these results are partial.\n")
		}
		synthPrompt.WriteString("\n")
		synthPrompt.WriteString(synthesisLanguageInstruction(lang))
		model := ""
		if t.Model != nil {
			model = *t.Model
		}
		if text, usage, ok := e.tryHostSynthesis(ctx, main, model, synthPrompt.String(), lang); ok {
			summary = text
			e.recordControllerUsage(ctx, id, executionID, main, "orchestration_synthesis", usage)
		} else {
			e.recordControllerUsage(ctx, id, executionID, main, "orchestration_synthesis", usage)
			e.emitOrchestrationFallback(ctx, id, executionID, main, "synthesis unavailable or empty", "synthesis")
		}
	}
	// The synthesis is told, but the note is appended here as well: a model
	// answer that reads as complete would be the one thing the reader cannot
	// check against a stopped worker.
	if stopped > 0 {
		summary = strings.TrimRight(summary, " \t\r\n") + "\n\n" + stoppedSomeNote(lang, stopped)
	}
	if !e.isActiveRun(id, executionID) {
		e.finishOrchestrated(ctx, id, executionID, true)
		return
	}
	e.emitSpeakerMessage(ctx, id, executionID, main, "assistant", summary, "orchestrator", "summary")
	// Re-seed host durable transcript (e.g. kin_messages) so the next same-host
	// follow-up can resume with this turn instead of only the live user line.
	// Orchestrate clears plugin session state at follow-up entry; without a seed
	// the host would claim "no prior context" after @worker completed.
	e.seedHostTranscriptAfterOrchestration(ctx, id, main, UserTurnPrompt(t.Prompt), summary)
	if !e.isActiveRun(id, executionID) {
		e.finishOrchestrated(ctx, id, executionID, true)
		return
	}

	res, _ := json.Marshal(map[string]any{
		"source":   "orchestrator",
		"is_error": anyErr,
		"steps":    len(plan.Steps),
		"waves":    len(waves),
		"main":     main,
	})
	_, _ = e.appendEventLockedForRun(ctx, id, executionID, "result", res)

	e.finishOrchestrated(ctx, id, executionID, anyErr)
}

func (e *Engine) persistWorkerPlan(
	ctx context.Context,
	taskID, executionID string,
	plan DelegatePlan,
	waves [][]int,
) error {
	now := e.nowMilli()
	waveOf := make(map[int]int, len(plan.Steps))
	for wi, wave := range waves {
		for _, index := range wave {
			waveOf[index] = wi
		}
	}
	steps := make([]store.WorkerStep, 0, len(plan.Steps))
	for index, step := range plan.Steps {
		deps := make([]int, 0)
		for prior := 0; prior < index; prior++ {
			if waveOf[prior] < waveOf[index] {
				deps = append(deps, prior)
			}
		}
		role := step.Phase
		if role == "" {
			role = "worker"
		}
		steps = append(steps, store.WorkerStep{
			TaskID:      taskID,
			ExecutionID: executionID,
			StepIndex:   index,
			Role:        role,
			DependsOn:   deps,
			Agent:       step.Agent,
			Provider:    step.Provider,
			Model:       step.Model,
			Access:      workerStepAccess(step),
			Status:      "planned",
			Attempt:     1,
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
	return e.store.InsertWorkerPlan(ctx, steps)
}

func (e *Engine) updateWorkerStep(
	ctx context.Context,
	taskID, executionID string,
	stepIndex int,
	patch store.WorkerStepPatch,
) {
	if err := e.store.UpdateWorkerStep(ctx, taskID, executionID, stepIndex, patch, e.nowMilli()); err != nil {
		// A step the reader stopped already has its terminal row. A retry path
		// that was in flight when the cancel landed, or the wave's own final
		// write, must not turn that into a persistence failure -- the store's
		// planned/running guard is exactly what refuses the write.
		if errors.Is(err, store.ErrNotFound) && e.workerStepCanceled(taskID, executionID, stepIndex) {
			return
		}
		e.noteRunPersistFailure(taskID, executionID, "result", nil, err)
	}
}

func (e *Engine) cancelWorkerSteps(ctx context.Context, taskID, executionID string) {
	status := StatusCanceled
	steps, err := e.store.ListWorkerSteps(ctx, taskID, executionID)
	if err != nil {
		e.noteRunPersistFailure(taskID, executionID, "result", nil, err)
		return
	}
	for _, step := range steps {
		if step.Status == "planned" || step.Status == "running" {
			e.updateWorkerStep(ctx, taskID, executionID, step.StepIndex, store.WorkerStepPatch{
				Status: &status,
			})
		}
	}
}

func workerStringPtr(value string) *string {
	return &value
}

func workerIntPtr(value int) *int {
	return &value
}

func workerRunMeta(meta adapter.RunMetadata, step DelegateStep) adapter.RunMetadata {
	if workerStepAccess(step) == "read" {
		meta.WorkspaceAccess = adapter.AccessSourceReadOnly
	} else if meta.WorkspaceAccess == adapter.AccessSourceReadOnly {
		meta.WorkspaceAccess = adapter.AccessWritable
	}
	return meta
}

func workerStepAccess(step DelegateStep) string {
	return normalizedStepAccess(step)
}

func workerPlanNeedsWrite(plan DelegatePlan) bool {
	for _, step := range plan.Steps {
		if workerStepAccess(step) == "write" {
			return true
		}
	}
	return false
}

func (e *Engine) promoteWorkerWorkspace(
	ctx context.Context,
	t store.Task,
	executionID string,
	runMeta adapter.RunMetadata,
) (store.Task, adapter.RunMetadata, error) {
	if e.workspace == nil {
		return t, runMeta, fmt.Errorf("workspace runtime unavailable")
	}
	ws, err := e.RequestWorkspace(ctx, WorkspaceIntentRequest{
		TaskID:      t.ID,
		ExecutionID: executionID,
		Agent:       t.Agent,
		Reason:      "writable multi-worker step",
	})
	if err != nil {
		return t, runMeta, err
	}
	t.CurrentWorkspaceID = ws.ID
	runMeta = e.resolveRunWorkspace(ctx, &t)
	runMeta.WorkspaceExecutionID = executionID
	if runMeta.WorkspaceAccess != adapter.AccessWritable {
		return t, runMeta, fmt.Errorf("writable worker workspace was not activated")
	}
	if err := e.claimCurrentWorkspaceExecution(ctx, t.ID, executionID); err != nil {
		return t, runMeta, err
	}
	return t, runMeta, nil
}

func (e *Engine) clearHandleGroup(id, executionID string) {
	e.mu.Lock()
	if e.activeRuns[id] == executionID {
		delete(e.handles, id)
		delete(e.handleGroups, id)
	}
	// Handles only: the wave loop still has to read which steps the reader
	// stopped after wg.Wait, and that flag outlives the processes.
	e.clearStepHandlesLocked(id, executionID)
	e.mu.Unlock()
}

func (e *Engine) runAcceptsWorker(taskID, executionID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, hasFollowUp := e.pendingFollowUp[taskID]
	return e.activeRuns[taskID] == executionID && !e.canceled[taskID] && !hasFollowUp
}

// registerWorkerStepHandle records a plan step's process under its run and
// step. It runs in the same critical section as the run's handle set: a
// per-step cancel that read the step map a moment before this call would
// otherwise report "not running" about a worker that had just started.
func (e *Engine) registerWorkerStepHandle(
	taskID, executionID string,
	stepIndex int,
	handle adapter.RunHandle,
) bool {
	key := workerStepKey{taskID: taskID, executionID: executionID, stepIndex: stepIndex}
	e.mu.Lock()
	_, hasFollowUp := e.pendingFollowUp[taskID]
	// A step the reader stopped between two attempts must not start its retry:
	// accepting the new process here would resurrect work the person just ended.
	accepted := e.activeRuns[taskID] == executionID &&
		!e.canceled[taskID] &&
		!hasFollowUp &&
		!e.canceledSteps[key]
	if accepted {
		if e.handleGroups == nil {
			e.handleGroups = make(map[string][]adapter.RunHandle)
		}
		e.handleGroups[taskID] = append(e.handleGroups[taskID], handle)
		e.handles[taskID] = handle
		e.stepHandles[key] = handle
		// Registered here means the workers have the prompt, which is the same
		// moment startOne clears it for a single-adapter run: the label exists only
		// while nothing has been handed the message (see Engine.queuedMessage), and
		// an orchestrated turn registers its handles here rather than there.
		delete(e.queuedMessage, taskID)
	}
	e.mu.Unlock()
	if !accepted {
		_ = handle.Cancel()
	}
	return accepted
}

// clearStepRuntimeLocked drops step handles and cancel flags for a task (or
// one of its runs, when executionID is non-empty). Callers hold e.mu.
func (e *Engine) clearStepRuntimeLocked(taskID, executionID string) {
	e.clearStepHandlesLocked(taskID, executionID)
	for key := range e.canceledSteps {
		if key.taskID == taskID && (executionID == "" || key.executionID == executionID) {
			delete(e.canceledSteps, key)
		}
	}
}

// clearStepHandlesLocked drops only the processes, leaving the cancel marks
// for whoever still has to read them. Callers hold e.mu.
func (e *Engine) clearStepHandlesLocked(taskID, executionID string) {
	for key := range e.stepHandles {
		if key.taskID == taskID && (executionID == "" || key.executionID == executionID) {
			delete(e.stepHandles, key)
		}
	}
}

// ErrWorkerStepNotRunning reports a per-step cancel that found nothing live to
// stop: the step already ended, never started, or belongs to an older run.
var ErrWorkerStepNotRunning = errors.New("worker step is not running")

// CancelWorkerStep stops one delegated worker without ending its task.
//
// The step is marked canceled before the process is killed, because the worker
// goroutine reads that mark to tell "the reader stopped me" from "I crashed":
// only the first suppresses the meta-retry and provider fallback that would
// otherwise start the same step again. The status write is the durable half,
// and the same mark makes the wave's own terminal write stand down when it
// arrives (see updateWorkerStep).
//
// Once the process is killed the mark is never dropped: a second cancel, a
// cancelled HTTP request or a failed status write must not hand the same step
// back to the retry paths, which would resurrect work the reader ended.
func (e *Engine) CancelWorkerStep(
	ctx context.Context,
	taskID, executionID string,
	stepIndex int,
) error {
	if taskID == "" || executionID == "" || stepIndex < 0 {
		return ErrWorkerStepNotRunning
	}
	key := workerStepKey{taskID: taskID, executionID: executionID, stepIndex: stepIndex}

	e.mu.Lock()
	// A cancel for this step is already in flight or already done. The second
	// ask is not an error and must not publish a second note; the mark is also
	// what keeps the worker's retry path from restarting it, so it stays.
	if e.canceledSteps[key] {
		e.mu.Unlock()
		return nil
	}
	handle, live := e.stepHandles[key]
	if !live || e.activeRuns[taskID] != executionID || e.canceled[taskID] {
		e.mu.Unlock()
		return ErrWorkerStepNotRunning
	}
	e.canceledSteps[key] = true
	e.mu.Unlock()

	if err := handle.Cancel(); err != nil {
		// Nothing was killed, so the step is still running and may be stopped
		// again once the process is reachable.
		e.mu.Lock()
		delete(e.canceledSteps, key)
		e.mu.Unlock()
		return fmt.Errorf("stop worker step: %w", err)
	}

	status := StatusCanceled
	now := e.nowMilli()
	if err := e.store.UpdateWorkerStep(ctx, taskID, executionID, stepIndex, store.WorkerStepPatch{
		Status: &status,
	}, now); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// The row is already terminal — a concurrent cancel wrote it, or the
			// wave got there first. The process is dead and the step is over,
			// which is what the caller asked for; the mark stays.
			return nil
		}
		// The process is dead but its row is not. Recording the failure would
		// normally fail the run; the mark still keeps the step from restarting.
		e.noteRunPersistFailure(taskID, executionID, "result", nil, err)
		return err
	}

	e.announceWorkerStepCanceled(ctx, taskID, executionID, stepIndex)
	e.resolvePendingForWorkerStep(ctx, taskID, stepIndex)
	return nil
}

// announceWorkerStepCanceled writes the one transcript line that explains why
// a worker's output stops mid-plan. The task keeps running, so without it the
// summary would simply be missing a step the reader deliberately ended.
func (e *Engine) announceWorkerStepCanceled(
	ctx context.Context,
	taskID, executionID string,
	stepIndex int,
) {
	t, err := e.store.GetTask(ctx, taskID)
	if err != nil {
		return
	}
	name := ""
	model := ""
	if steps, listErr := e.store.ListWorkerSteps(ctx, taskID, executionID); listErr == nil {
		for _, step := range steps {
			if step.StepIndex == stepIndex {
				name = step.Agent
				model = step.Model
				break
			}
		}
	}
	if strings.TrimSpace(name) == "" {
		return
	}
	display := e.agentDisplayName(name, model)
	var text string
	if responseLanguageForPrompt(UserTurnPrompt(t.Prompt)) == responseLanguageChinese {
		text = fmt.Sprintf("已停止 **%s**（步骤 %d）", display, stepIndex+1)
	} else {
		text = fmt.Sprintf("Stopped **%s** (step %d)", display, stepIndex+1)
	}
	e.emitSpeakerMessage(ctx, taskID, executionID, t.Agent, "assistant", text, "orchestrator", "progress")
}

// resolvePendingForWorkerStep answers the cards a stopped worker left behind.
// The process that asked is gone, so an approval or question kept pending
// would stay on screen as a decision nobody can act on and would keep the
// task's "needs you" light on for work that no longer exists.
//
// Cards are matched by step number, because that is the field attributed with
// the plan step (the execution id on the card is the adapter attempt, which
// the engine does not map back to a turn). A card from an earlier turn with
// the same number names a process that has already exited, so resolving it is
// right as well.
func (e *Engine) resolvePendingForWorkerStep(ctx context.Context, taskID string, stepIndex int) {
	stepNumber := stepIndex + 1
	if pending, err := e.store.ListPendingForTask(ctx, taskID); err == nil {
		for _, a := range pending {
			if a.ExecutionStep != nil && *a.ExecutionStep == stepNumber {
				_, _ = e.Decide(ctx, a.ID, store.DecisionDenied, "interrupt")
			}
		}
	}
	if pending, err := e.store.ListPendingUserQuestionsForTask(ctx, taskID); err == nil {
		for _, q := range pending {
			if q.ExecutionStep != nil && *q.ExecutionStep == stepNumber {
				_, _ = e.AnswerUserQuestion(ctx, q.ID, AnswerUserQuestionRequest{}, "interrupt")
			}
		}
	}
}

// workerStepCanceled reports whether a person stopped this step of this run.
func (e *Engine) workerStepCanceled(taskID, executionID string, stepIndex int) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.canceledSteps[workerStepKey{
		taskID:      taskID,
		executionID: executionID,
		stepIndex:   stepIndex,
	}]
}

// stoppedWorkerSteps counts the plan steps of this run a person ended. Only
// CancelWorkerStep sets the mark, so this is not "failed" and not "never ran".
func (e *Engine) stoppedWorkerSteps(taskID, executionID string, total int) int {
	stopped := 0
	for i := 0; i < total; i++ {
		if e.workerStepCanceled(taskID, executionID, i) {
			stopped++
		}
	}
	return stopped
}

// stoppedSomeNote marks a partial answer: some workers finished, and the
// reader ended at least one. It follows the turn's response language.
func stoppedSomeNote(lang responseLanguage, n int) string {
	if lang == responseLanguageChinese {
		return fmt.Sprintf("（已停止 %d 个 worker，以上结果可能不完整。）", n)
	}
	if n == 1 {
		return "(1 worker was stopped, so the result above may be incomplete.)"
	}
	return fmt.Sprintf("(%d workers were stopped, so the result above may be incomplete.)", n)
}

// stoppedEverythingNote is the whole answer when no worker was left to finish:
// there is no result to present, only the fact that the work was ended.
func stoppedEverythingNote(lang responseLanguage, n int) string {
	if lang == responseLanguageChinese {
		return fmt.Sprintf("已停止全部 %d 个 worker，本轮没有产出结果。", n)
	}
	if n == 1 {
		return "The only worker was stopped, so this turn produced no result."
	}
	return fmt.Sprintf("All %d workers were stopped, so this turn produced no result.", n)
}

// unregisterWorkerStepHandle drops a step's handle when its worker goroutine
// returns, so a cancel that arrives after the stream closed reports "not
// running" instead of killing a process that had already answered.
func (e *Engine) unregisterWorkerStepHandle(taskID, executionID string, stepIndex int) {
	e.mu.Lock()
	delete(e.stepHandles, workerStepKey{
		taskID:      taskID,
		executionID: executionID,
		stepIndex:   stepIndex,
	})
	e.mu.Unlock()
}

func (e *Engine) finishOrchestrated(ctx context.Context, id, executionID string, failed bool) {
	e.finishOrchestratedAs(ctx, id, executionID, failed, false)
}

// finishOrchestratedCanceled ends a turn someone stopped on purpose. Every
// worker in the plan is gone, so there is no result to call delivered; the
// task ends canceled, the same way a whole-task cancel reads.
func (e *Engine) finishOrchestratedCanceled(ctx context.Context, id, executionID string) {
	e.finishOrchestratedAs(ctx, id, executionID, false, true)
}

func (e *Engine) finishOrchestratedAs(ctx context.Context, id, executionID string, failed, canceled bool) {
	e.mu.Lock()
	currentRun := e.activeRuns[id] == executionID
	if currentRun {
		e.workspaceCommitting[id] = executionID
	}
	wasCanceled := e.canceled[id]
	pf, hasFollowUp := e.pendingFollowUp[id]
	if currentRun {
		delete(e.handles, id)
		delete(e.handleGroups, id)
		delete(e.canceled, id)
		delete(e.pendingFollowUp, id)
	}
	// Scoped by run, so a stale turn ending cannot drop the live turn's steps.
	e.clearStepRuntimeLocked(id, executionID)
	e.active--
	e.mu.Unlock()
	if !currentRun {
		e.cancelWorkerSteps(ctx, id, executionID)
		e.pump()
		return
	}
	defer e.clearWorkspaceCompletion(id, executionID)
	defer e.clearActiveRun(id, executionID)
	workspaceStatus, workspaceErr, workspaceFinalized := e.finalizeRequestedWorkspace(ctx, id)

	// Interrupted with a steerable follow-up: re-queue instead of staying canceled.
	if hasFollowUp {
		if workspaceErr != nil {
			e.emitError(ctx, id, executionID, "workspace finalization failed before follow-up: "+workspaceErr.Error())
			_, _ = e.finishRun(ctx, id, executionID, StatusFailed, nil, nil)
			e.pump()
			return
		}
		if _, err := e.applyPendingFollowUp(ctx, id, pf); err != nil {
			// Store-direct, not emitError: a cancel that refused this delivery has
			// already cleared the active-run entry, and a run-scoped write returns
			// ErrConflict there -- the refusal would be reported to nobody.
			e.reportUndelivered(ctx, id, err)
			_, _ = e.finishRun(ctx, id, executionID, e.endStatusForDelivery(err), nil, nil)
		} else {
			e.clearActiveRun(id, executionID)
		}
		e.pump()
		return
	}

	if wasCanceled {
		e.clearPersistTracking(id)
		_, _ = e.finishRun(ctx, id, executionID, StatusCanceled, nil, nil)
		e.pump()
		return
	}
	// A prompt queued during this turn is delivered now, the same way the adapter
	// loop delivers one: an orchestrated turn ends just as much at a turn boundary.
	if workspaceErr == nil {
		if _, ok, err := e.deliverQueuedPrompt(ctx, id); err != nil {
			// err before ok: a failed attempt is not an empty queue (see
			// deliverQueuedPrompt), and this is the only place that would say so.
			// The error already names the message it lost; a prefix here would
			// say it twice. Store-direct for the same reason as the adapter loop's
			// twin (engine.go): the cancel that refused the write also cleared the
			// active-run entry, so a run-scoped report would be dropped by the one
			// reader waiting for it.
			e.reportUndelivered(ctx, id, err)
			_, _ = e.finishRun(ctx, id, executionID, e.endStatusForDelivery(err), nil, nil)
			e.pump()
			return
		} else if ok {
			e.clearActiveRun(id, executionID)
			e.pump()
			return
		}
	} else if pending, perr := e.store.ListPendingPrompts(ctx, id); perr == nil && len(pending) > 0 {
		// Nothing will deliver these: the run ends here and the workspace is
		// mid-flight. Cancel reports its own drops; this drop needs its own report.
		e.emitError(ctx, id, executionID, fmt.Sprintf(
			"%d queued prompt(s) not delivered: workspace finalization failed", len(pending)))
	}
	final := StatusSucceeded
	if failed || e.hasCriticalPersistFailure(id) {
		final = StatusFailed
	}
	if canceled {
		// The reader ended the work themselves; that is a cancel, not a failure
		// and not a delivery.
		final = StatusCanceled
	}
	if workspaceFinalized {
		if workspaceErr != nil {
			e.emitError(ctx, id, executionID, "workspace finalization failed: "+workspaceErr.Error())
			final = StatusFailed
		} else if workspaceStatus != StatusSucceeded {
			final = workspaceStatus
		}
	}
	e.clearPersistTracking(id)
	_, _ = e.finishRun(ctx, id, executionID, final, nil, nil)
	e.pump()
}

// seedHostTranscriptAfterOrchestration writes a minimal host-facing transcript
// (live user turn + orchestration summary) into the durable messages store so
// managed-transcript hosts (Kin) can same-agent resume after multi-@ runs.
// Best-effort: failures leave the next follow-up on the sealed-pack fallback.
func (e *Engine) seedHostTranscriptAfterOrchestration(ctx context.Context, taskID, host, userTurn, summary string) {
	if e == nil || e.store == nil {
		return
	}
	reg, ok := e.agents.Get(host)
	if !ok || reg.Sessions == nil {
		// Only hosts with plugin-private session state need a durable seed.
		return
	}
	userTurn = strings.TrimSpace(userTurn)
	summary = strings.TrimSpace(summary)
	if userTurn == "" && summary == "" {
		return
	}
	msgs := make([]store.KinMessage, 0, 2)
	if userTurn != "" {
		msgs = append(msgs, store.KinMessage{Role: "user", Content: userTurn})
	}
	if summary != "" {
		msgs = append(msgs, store.KinMessage{Role: "assistant", Content: summary})
	}
	if err := e.store.ReplaceKinMessages(ctx, taskID, msgs); err != nil {
		// Non-fatal: next follow-up falls back to sealed pack when transcript empty.
		payload, _ := json.Marshal(map[string]string{
			"message": fmt.Sprintf("seed host transcript after orchestration failed: %v", err),
		})
		_, _ = e.appendEventLocked(ctx, taskID, "error", payload)
	}
}

// forwardWorkerEvents copies adapter events onto the parent task, stamping speaker.
// Safe for concurrent waves (serialized via eventMu).
// Returns the worker summary text, whether it failed, and a classified failure
// for fallback decisions (zero value when no fallback-relevant error occurred).
func (e *Engine) forwardWorkerEvents(
	ctx context.Context,
	taskID, executionID, agent, model string,
	exec adapter.ExecutionRef,
	h adapter.RunHandle,
) (string, bool, routing.Failure) {
	// Collect only final, user-facing findings for the orchestrator summary.
	// Process chatter (partials / intermediate tool narration) stays on the event
	// bus for the progress UI, but must not become the main-chat "结果".
	var finals []string
	var resultText string
	sawResult := false
	sawUsage := false
	isErr := false
	var lastErrMsg string

	for ev := range h.Events() {
		if !e.isActiveRun(taskID, executionID) {
			continue
		}
		payload := stampWorker(ev.Payload, agent, model, exec, executionID)
		semantic, semanticErr := adapter.DecodeEvent(ev)
		// Same as runLoop: steer interrupt cancel errors must not land in the transcript.
		skipPersist := false
		if semanticErr == nil && semantic.Error != nil && semantic.Error.Canceled {
			e.mu.Lock()
			_, steer := e.pendingFollowUp[taskID]
			e.mu.Unlock()
			skipPersist = steer
		}
		if !skipPersist {
			shouldAccount := ev.Type == "usage" ||
				(ev.Type == "result" && !sawUsage && semanticErr == nil &&
					semantic.Usage != nil && semantic.Usage.HasAccountingValues())
			accounted := false
			if shouldAccount {
				accounted, _ = e.appendUsageEventLockedForRun(
					ctx, taskID, executionID, ev.Type, payload, agent, model,
				)
				if accounted && ev.Type == "usage" {
					sawUsage = true
				}
			}
			if !accounted {
				_, _ = e.appendEventLockedForRun(
					ctx, taskID, executionID, ev.Type, payload,
				)
			}
		}
		switch ev.Type {
		case "message":
			if semanticErr == nil && semantic.Message != nil &&
				!semantic.Message.Partial &&
				semantic.Message.Role != "reasoning" &&
				semantic.Message.Role != "system" &&
				semantic.Message.Role != "user" {
				t := strings.TrimSpace(semantic.Message.Text)
				if t != "" {
					finals = append(finals, t)
				}
			}
		case "result":
			sawResult = true
			if semanticErr != nil || semantic.Result == nil {
				isErr = true
			} else {
				isErr = semantic.Result.IsError
				if t := strings.TrimSpace(semantic.Result.Text); t != "" {
					resultText = t
				}
				if isErr && semantic.Error != nil {
					lastErrMsg = semantic.Error.Message
				}
			}
		case "error":
			if !skipPersist {
				isErr = true
				if semanticErr == nil && semantic.Error != nil {
					lastErrMsg = semantic.Error.Message
				}
			}
		}

		e.mu.Lock()
		canceled := e.canceled[taskID]
		e.mu.Unlock()
		if canceled {
			_ = h.Cancel()
			return chooseWorkerSummary(resultText, finals), true, routing.Failure{}
		}
	}
	if !sawResult {
		isErr = true
	}
	summary := chooseWorkerSummary(resultText, finals)

	// Classify the failure for fallback decisions.
	var failure routing.Failure
	if isErr && lastErrMsg != "" {
		failure = routing.ClassifyFailure(fmt.Errorf("%s", lastErrMsg), exec.ProviderID, exec.Model)
	}
	return summary, isErr, failure
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
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "message", Payload: raw})
	if err != nil || semantic.Message == nil {
		return ""
	}
	message := semantic.Message
	if message.Partial {
		return ""
	}
	if message.Role == "reasoning" || message.Role == "system" || message.Role == "user" {
		return ""
	}
	return strings.TrimSpace(message.Text)
}

// extractResultText pulls a final answer string from a result event payload.
func extractResultText(raw json.RawMessage) string {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "result", Payload: raw})
	if err != nil || semantic.Result == nil {
		return ""
	}
	return strings.TrimSpace(semantic.Result.Text)
}

// extractErrorMessage pulls the "message" field from a JSON payload.
func extractErrorMessage(raw json.RawMessage) string {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "error", Payload: raw})
	if err != nil || semantic.Error == nil {
		return ""
	}
	return strings.TrimSpace(semantic.Error.Message)
}

// appendEventLocked persists then publishes an event (append-first rule).
// Critical failures are recorded so the task cannot terminate as a normal
// success with a missing audit trail. Safe for concurrent waves (eventMu).
func (e *Engine) appendEventLocked(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error) {
	e.eventMu.Lock()
	defer e.eventMu.Unlock()
	w := e.eventWriter()
	if w == nil {
		err := fmt.Errorf("event writer unavailable")
		e.notePersistFailure(taskID, typ, payload, err)
		return store.Event{}, err
	}
	stored, err := w.AppendEvent(ctx, taskID, typ, payload)
	if err != nil {
		e.notePersistFailure(taskID, typ, payload, err)
		return store.Event{}, err
	}
	e.bus.PublishEvent(stored)
	e.maybeEmitPersistDiagnostic(ctx, taskID)
	return stored, nil
}

func (e *Engine) appendEventLockedForRun(
	ctx context.Context,
	taskID, executionID, typ string,
	payload json.RawMessage,
) (store.Event, error) {
	stored, err := e.persistRunEvent(ctx, taskID, executionID, typ, payload)
	if err != nil {
		if !errors.Is(err, store.ErrConflict) {
			e.noteRunPersistFailure(taskID, executionID, typ, payload, err)
		}
		return store.Event{}, err
	}
	e.bus.PublishEvent(stored)
	return stored, nil
}

func (e *Engine) emitSpeakerMessage(
	ctx context.Context,
	taskID, executionID, agentID, role, text, source, phase string,
) {
	// Host plan/delegate/summary are user-facing; other sources default to task+user.
	userFacing := source == OriginOrchestrator || source == OriginDelegate || source == OriginHost
	vis := VisibilityUserFacing()
	if !userFacing {
		vis = VisibilityTaskOnly()
	}
	payload, err := MarshalMessage(text, EventAttribution{
		Speaker:    agentID,
		Agent:      agentID,
		Source:     source,
		Phase:      phase,
		Role:       role,
		Visibility: &vis,
	})
	if err != nil {
		// Fall back to a minimal map if marshaling fails (should not happen).
		payload, _ = json.Marshal(map[string]any{
			"role": role, "content": []map[string]string{{"type": "text", "text": text}},
			"partial": false, "agent": agentID, "speaker": agentID, "source": source, "phase": phase,
			"visibility": map[string]bool{"user": userFacing, "task": true},
		})
	}
	_, _ = e.appendEventLockedForRun(ctx, taskID, executionID, "message", payload)
}

func (e *Engine) emitError(ctx context.Context, taskID, executionID, msg string) {
	payload, _ := json.Marshal(map[string]string{"message": msg})
	_, _ = e.appendEventLockedForRun(ctx, taskID, executionID, "error", payload)
}

// stampSpeaker tags events for the user-facing main agent / single-agent runs.
// A host adapter's role:"user" events are input echoes (prompt replay,
// tool_result blocks, skill preambles), never the agent's own answer — mark
// them task-only so they stay out of the main chat. The real user turn is
// emitted separately with speaker="user" and never flows through here.
func stampSpeaker(raw json.RawMessage, agent, model string, exec adapter.ExecutionRef) json.RawMessage {
	return stampAgent(raw, agent, model, isUserRoleEcho(raw), exec)
}

// isUserRoleEcho reports whether an adapter payload is a role:"user" message,
// i.e. model input replayed in the stream rather than the agent's output.
func isUserRoleEcho(raw json.RawMessage) bool {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "message", Payload: raw})
	return err == nil && semantic.Message != nil &&
		strings.EqualFold(strings.TrimSpace(semantic.Message.Role), "user")
}

// stampWorker tags sub-agent events as task-only (hidden from main chat column).
//
// runExecutionID is the turn the step belongs to, which is the id the plan
// table stores per step. `execution_id` alone is the concrete adapter attempt:
// a meta-retry or provider fallback starts a new process under the same step,
// so a plan row cannot be joined to its events (or its tokens summed across
// attempts) by that field. The extra field makes the join exact and additive.
func stampWorker(raw json.RawMessage, agent, model string, exec adapter.ExecutionRef, runExecutionID string) json.RawMessage {
	return stampAgentRun(raw, agent, model, true, exec, runExecutionID)
}

func stampAgent(raw json.RawMessage, agent, model string, taskOnly bool, exec adapter.ExecutionRef) json.RawMessage {
	return stampAgentRun(raw, agent, model, taskOnly, exec, "")
}

func stampAgentRun(raw json.RawMessage, agent, model string, taskOnly bool, exec adapter.ExecutionRef, runExecutionID string) json.RawMessage {
	vis := VisibilityUserFacing()
	if taskOnly {
		vis = VisibilityTaskOnly()
	}
	attr := EventAttribution{
		Speaker:    agent,
		Agent:      agent,
		Source:     agent,
		Model:      model,
		Visibility: &vis,
		Execution:  exec,
	}
	if len(raw) == 0 {
		m := map[string]any{}
		ApplyAttribution(m, attr)
		stampRunExecutionID(m, runExecutionID)
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
	// Stamping always owns agent/speaker identity for this run.
	m["agent"] = agent
	m["speaker"] = agent
	if providerID := strings.TrimSpace(exec.ProviderID); providerID != "" {
		m["provider_id"] = providerID
	}
	if reported, ok := m["model"].(string); !ok || strings.TrimSpace(reported) == "" {
		if model = strings.TrimSpace(model); model != "" {
			m["model"] = model
		} else {
			delete(m, "model")
		}
	}
	// Never overwrite an explicit visibility from the emitter (e.g. kinagent tools).
	// ApplyAttribution preserves existing visibility and only fills source when unset.
	ApplyAttribution(m, attr)
	stampRunExecutionID(m, runExecutionID)
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

func stampRunExecutionID(m map[string]any, runExecutionID string) {
	if id := strings.TrimSpace(runExecutionID); id != "" {
		m["run_execution_id"] = id
	}
}

// applyExecutionMeta stamps immutable adapter-run identity onto event metadata.
func applyExecutionMeta(m map[string]any, exec adapter.ExecutionRef) {
	if m == nil {
		return
	}
	if id := strings.TrimSpace(exec.ID); id != "" {
		m["execution_id"] = id
	}
	if exec.Step > 0 {
		m["execution_step"] = exec.Step
	}
	if agent := strings.TrimSpace(exec.Agent); agent != "" {
		m["execution_agent"] = agent
	}
	if model := strings.TrimSpace(exec.Model); model != "" {
		m["execution_model"] = model
	}
}

func extractMessageTextFromRaw(raw json.RawMessage) string {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "message", Payload: raw})
	if err != nil || semantic.Message == nil {
		return ""
	}
	return semantic.Message.Text
}

func resultIsError(raw json.RawMessage) bool {
	semantic, err := adapter.DecodeEvent(adapter.Event{Type: "result", Payload: raw})
	return err == nil && semantic.Result != nil && semantic.Result.IsError
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
	// Match the original user turn's language for any user-visible findings.
	live := strings.TrimSpace(plan.Raw)
	if live == "" {
		live = step.Instruction
	}
	return withReplyLanguage(b.String(), live)
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

// buildUserFacingSummary is the deterministic fallback for the final chat
// message. WorkerDigest remains available for internal model context, but its
// labels and task-log pointers must never be used as user-facing output.
func buildUserFacingSummary(userPrompt string, prior []string, priorFailed []bool, anyErr bool) string {
	lang := responseLanguageForPrompt(userPrompt)
	var b strings.Builder
	if lang == responseLanguageChinese {
		if anyErr {
			b.WriteString("已完成，但有部分工作未成功：\n\n")
		} else {
			b.WriteString("已完成：\n\n")
		}
	} else if anyErr {
		b.WriteString("Completed, but some work was unsuccessful:\n\n")
	} else {
		b.WriteString("Completed:\n\n")
	}

	count := 0
	for i, p := range prior {
		failed := i < len(priorFailed) && priorFailed[i]
		cleaned, ok := cleanUserFacingSynthesis(sessionctx.WorkerDigest(p, failed), lang)
		if !ok {
			continue
		}
		if count > 0 {
			b.WriteString("\n\n")
		}
		if failed {
			if lang == responseLanguageChinese {
				b.WriteString("失败：")
			} else {
				b.WriteString("Issue: ")
			}
		}
		b.WriteString(cleaned)
		count++
	}
	if count == 0 {
		if lang == responseLanguageChinese {
			b.WriteString("没有可显示的结果。")
		} else {
			b.WriteString("No result was available to display.")
		}
	}
	return strings.TrimSpace(b.String())
}

func effectiveStepModel(t store.Task, step DelegateStep) string {
	if m := strings.TrimSpace(step.Model); m != "" {
		// Normalize known aliases (opus/haiku/...) so adapters get canonical ids.
		if id, ok := BuiltinCatalog().Normalize(step.Agent, m); ok {
			return id
		}
		return m
	}
	// Same-agent only: host model may apply (model-switch workers always set
	// step.Model explicitly; this covers residual same-agent steps).
	// Cross-agent workers must NOT inherit the host model — Claude aliases
	// like "opus" are invalid on Kin/provider and other backends.
	if step.Agent == t.Agent && t.Model != nil {
		return strings.TrimSpace(*t.Model)
	}
	return ""
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
