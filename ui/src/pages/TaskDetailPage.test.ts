import { describe, expect, it } from "vitest";
import source from "./TaskDetailPage.tsx?raw";

describe("TaskDetailPage session rail breakpoints", () => {
  it("keeps compact usage visible until the side rail appears", () => {
    const compactClasses = source.match(
      /<div className="([^"]+)">\s*<TaskUsageSummary/,
    )?.[1];
    const railClasses = source.match(
      /<aside\s+className="([^"]+)"\s+aria-label=\{tr\("task\.sessionRail"\)\}/,
    )?.[1];

    expect(compactClasses).toContain("min-[1600px]:hidden");
    expect(compactClasses).not.toContain("xl:hidden");
    expect(compactClasses?.split(/\s+/)).not.toContain("hidden");
    expect(railClasses?.split(/\s+/)).toContain("hidden");
    expect(railClasses).toContain("min-[1600px]:flex");
  });
});
