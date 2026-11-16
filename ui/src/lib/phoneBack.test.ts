// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goBackToList } from "./phoneBack";

/**
 * KIN-CONTINUE-002: one back rule for every phone screen.
 *
 * The two branches are what a component test cannot see: MemoryRouter never
 * writes `window.history.state`, so every route test takes the cold fallback.
 */

afterEach(() => {
  window.history.replaceState({ idx: 0 }, "", "/");
});

describe("goBackToList", () => {
  it("pops the history entry when the list is behind this screen", () => {
    window.history.replaceState({ idx: 1, key: "list-then-destination" }, "", "/routines");
    const navigate = vi.fn();
    goBackToList(navigate);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it("replaces a cold deep link with the list", () => {
    window.history.replaceState({ idx: 0 }, "", "/routines");
    const navigate = vi.fn();
    goBackToList(navigate);
    expect(navigate).toHaveBeenCalledWith("/sessions", { replace: true });
  });

  it("is the only back rule the detail pages write", () => {
    // Two back affordances on one screen must not disagree about the cold
    // fallback: a push there leaves the deep link in history, so the system
    // Back reopens the screen the reader just left.
    // `import.meta.url` resolves to the served path under some runners; the
    // working tree is the reliable anchor.
    const ui = existsSync(join(process.cwd(), "src/pages"))
      ? process.cwd()
      : join(process.cwd(), "ui");
    for (const page of ["TaskDetailPage", "ProjectDetailPage", "AgentSessionDetailPage"]) {
      const source = readFileSync(join(ui, "src/pages", `${page}.tsx`), "utf8");
      expect(source, page).toContain("goBackToList(navigate)");
      expect(source, page).not.toContain("window.history.state?.idx");
    }
  });
});
