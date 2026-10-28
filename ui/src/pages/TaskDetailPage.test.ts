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
});
