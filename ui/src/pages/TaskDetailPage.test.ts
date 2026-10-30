import { describe, expect, it } from "vitest";
import source from "./TaskDetailPage.tsx?raw";

describe("TaskDetailPage session rail breakpoints", () => {
  it("keeps compact usage visible until the side rail appears, and off the phone", () => {
    const stripClasses = source.match(
      /<div className="([^"]+)">\s*<div className="max-md:hidden">\s*<TaskUsageSummary/,
    )?.[1];
    const usageClasses = source.match(/<div className="([^"]+)">\s*<TaskUsageSummary/)?.[1];
    const railClasses = source.match(
      /<aside\s+className="([^"]+)"\s+aria-label=\{tr\("task\.sessionRail"\)\}/,
    )?.[1];

    // The strip hides when the side rail takes over, and the usage bar is
    // gone on a phone (its trigger lives in the composer footer there).
    expect(stripClasses).toContain("min-[1600px]:hidden");
    expect(stripClasses).not.toContain("xl:hidden");
    expect(stripClasses?.split(/\s+/)).not.toContain("hidden");
    expect(usageClasses).toContain("max-md:hidden");
    expect(railClasses?.split(/\s+/)).toContain("hidden");
    expect(railClasses).toContain("min-[1600px]:flex");
  });

  it("keeps retry generations isolated when the response is uncertain", () => {
    expect(source).toContain("lastObservedEventSeq.current = 0");
    expect(source).toContain("!retryAccepted && err instanceof ApiError");
    expect(source).toContain("const restored = liveResources.restoreTaskEvents(eventReset)");
    expect(source).toContain("if (!restored) void liveResources.refreshTask(task.id, true)");
  });

  it("edits a queued message by withdrawing it first, into an empty composer", () => {
    // The properties the wiring has to keep: the edit is offered next to the ×
    // (so a queued message has both), and the text is put back in exactly one
    // place — the branch where the daemon said it deleted the row. What each
    // ending means, and that a 404 refills nothing, is `startEdit`'s own test.
    expect(source).toContain("onEditQueued={onEditQueued}");
    expect(source).toContain("onUnqueue={onWithdrawQueued}");

    const start = source.indexOf("const onEditQueued");
    expect(start).toBeGreaterThan(-1);
    const edit = source.slice(start, source.indexOf("// What the composer's @ menu", start));

    // The composer has to be free before anything is taken back, and again when
    // the answer lands: a round trip is long enough to type into.
    expect(edit.indexOf("canRefillComposer({")).toBeGreaterThan(-1);
    expect(edit.indexOf("canRefillComposer({")).toBeLessThan(edit.indexOf("startEdit({"));
    expect(edit.match(/canRefillComposer\(\{/g)).toHaveLength(2);
    // A request that never answers must not refuse every tap for the session,
    // and a stalled one that settles late must not clear a newer request's
    // deadline and let a third run beside it.
    expect(edit).toContain("editStillRunning(editStartedAtRef.current, Date.now())");
    expect(edit).toContain(
      "if (editStartedAtRef.current === startedAt) editStartedAtRef.current = 0;",
    );

    expect(edit).toMatch(/case "withdrawn":\s*refillComposer\(\);/);
    expect(source.match(/refillComposer\(\);/g)).toHaveLength(1);
  });

  it("moves the caret into the composer a refill lands in", () => {
    expect(source).toContain("focusSignal={refill.taskID === task.id ? refill.n : 0}");
    expect(source).toContain("setRefill((prev) => ({ taskID: id, n: prev.n + 1 }))");
  });

  it("does not clear a draft that a send did not start from", () => {
    // Editing a queued message can refill the composer while a send is in
    // flight. The send's cleanup must not delete the text that landed there,
    // and a failure must tell the composer the same thing.
    expect(source).toContain("const submittedDraft = draftPromptRef.current");
    expect(source).toContain("if (draftPromptRef.current === submittedDraft) {");
    expect(source).toContain(
      "(failure as SubmitFailure).keepComposer = draftPromptRef.current !== submittedDraft;",
    );
  });

  it("stops one worker by its plan identity and refreshes the panel", () => {
    // The cancel endpoint is keyed by the plan row's execution id and step
    // index -- not the event's attempt id, which the panel never shows as an
    // identity. A row the reader can see but the API cannot name is a button
    // that always fails.
    expect(source).toContain("cancelWorkerStep(task.id, row.executionId, row.stepIndex)");
    expect(source).toContain("void listWorkerSteps(task.id)");
    expect(source).toContain("if (taskIdRef.current === task.id) setWorkerSteps(steps);");
    // A 409 is the step having settled, not a failure worth a toast.
    expect(source).toContain("err instanceof ApiError && err.status === 409");
    // One stop in flight at a time, and no stop offered on a settled task.
    expect(source).toContain("if (!task || workerStoppingKey) return;");
    expect(source).toContain("stoppingKey={workerStoppingKey}");
    expect(source).toContain("onStop={isTerminal(task.status) ? undefined : onStopWorker}");
  });

  it("keeps the answer in place and rebuilds answers the stream remembers", () => {
    // The pending row leaves the moment it is decided. The card has to stay
    // where it was asked: this pane's own answer is retained, and a decision
    // made on another device (or before a reload) comes back from the
    // request + decision events. KIN-CONTINUE-001.
    expect(source).toContain("const [decidedApprovals, setDecidedApprovals]");
    expect(source).toMatch(/setDecidedApprovals\(\(prev\) => \{[\s\S]*?\[id\]: updated/);
    expect(source).toContain("mergeDecidedApprovals(approvals, decidedApprovals, events)");
    expect(source).toContain("decided: true");
  });
});
