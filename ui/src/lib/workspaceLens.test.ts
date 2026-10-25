import { describe, expect, it } from "vitest";
import { WORKSPACE_LENSES, derivedLens, lensForPick, type LensPick } from "./workspaceLens";

const TASK = "task-1";
const SOURCE = "source";
const GENERATION_3 = "generation:g3";

describe("derivedLens", () => {
  it("shows the changes when there are any, the tree otherwise", () => {
    expect(derivedLens(true)).toBe("changes");
    expect(derivedLens(false)).toBe("files");
  });

  it("offers exactly the two lenses it can return", () => {
    expect([...WORKSPACE_LENSES].sort()).toEqual([derivedLens(false), derivedLens(true)].sort());
  });
});

describe("lensForPick", () => {
  it("falls back to the derived lens with nothing picked", () => {
    expect(lensForPick(null, TASK, SOURCE, true)).toBe("changes");
    expect(lensForPick(null, TASK, SOURCE, false)).toBe("files");
  });

  it("uses the lens picked for this place", () => {
    const pick: LensPick = { taskId: TASK, view: SOURCE, lens: "files" };
    expect(lensForPick(pick, TASK, SOURCE, true)).toBe("files");
  });

  // The reason `view` is in the key at all: the changes of one generation say
  // nothing about the changes of the next, so the pick does not survive the
  // switch — and neither does it follow the person into another session.
  it("ignores a pick made somewhere else", () => {
    const pick: LensPick = { taskId: TASK, view: GENERATION_3, lens: "files" };
    expect(lensForPick(pick, TASK, "generation:g4", true)).toBe("changes");
    expect(lensForPick(pick, TASK, SOURCE, true)).toBe("changes");
    expect(lensForPick(pick, "task-2", GENERATION_3, true)).toBe("changes");
  });

  // A pick outranks the default, including when the default would have moved:
  // the changes tab is drawn disabled and empty rather than swapping the list
  // under somebody who chose it.
  it("keeps a picked lens when the changes go away", () => {
    const pick: LensPick = { taskId: TASK, view: GENERATION_3, lens: "changes" };
    expect(lensForPick(pick, TASK, GENERATION_3, false)).toBe("changes");
  });

  // Coming back to a place is not a new place: nothing about looking at another
  // generation clears the pick, so the lens is found again on return.
  it("still answers for its own place after another was looked at", () => {
    const pick: LensPick = { taskId: TASK, view: GENERATION_3, lens: "changes" };
    expect(lensForPick(pick, TASK, SOURCE, true)).toBe("changes");
    expect(lensForPick(pick, TASK, GENERATION_3, true)).toBe("changes");
  });
});
