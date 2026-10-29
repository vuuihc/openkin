import { describe, expect, it } from "vitest";
import source from "./TaskDetailPage.tsx?raw";

describe("TaskDetailPage session rail breakpoints", () => {
  it("keeps compact usage visible until the side rail appears, and off the phone", () => {
    const stripClasses = source.match(/<div className="([^"]+)">\s*<div className="max-md:hidden">\s*<TaskUsageSummary/)?.[1];
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
    expect(edit).toContain("if (editStartedAtRef.current === startedAt) editStartedAtRef.current = 0;");

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
});
