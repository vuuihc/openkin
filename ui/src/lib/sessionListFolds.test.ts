import { describe, expect, it } from "vitest";
import { resolveSessionListFolds, type SessionListFoldCandidate } from "./sessionListFolds";

/**
 * KIN-CONTINUE-007: the list opens on the project the person was last in.
 *
 * The resolver is pure, so these are the fold rules themselves: no storage,
 * no clock, no render.
 */

const ALPHA = "mac-1::/work/alpha";
const BETA = "mac-1::/work/beta";
const IMPORTED = "mac-1::imported\u0000mac-1";

function candidate(
  stateKey: string,
  lastActivityAt: number,
  imported = false,
  pinned = false,
): SessionListFoldCandidate {
  return { stateKey, imported, pinned, lastActivityAt };
}

describe("session list folds", () => {
  it("opens only the most recent project by default", () => {
    const folds = resolveSessionListFolds([candidate(ALPHA, 100), candidate(BETA, 200)], {});

    expect(folds).toEqual({ [ALPHA]: false, [BETA]: true });
  });

  it("keeps a remembered open project and closes the others", () => {
    const folds = resolveSessionListFolds([candidate(ALPHA, 200), candidate(BETA, 100)], {
      [BETA]: true,
    });

    expect(folds).toEqual({ [ALPHA]: false, [BETA]: true });
  });

  it("keeps the imported group folded by default", () => {
    // The imported group is the newest thing on screen; it still starts
    // folded, because an import is an index rather than a place the person
    // was last in (the `SessionList` rule this must not regress).
    const folds = resolveSessionListFolds(
      [candidate(ALPHA, 100), candidate(BETA, 200), candidate(IMPORTED, 300, true)],
      {},
    );

    expect(folds[IMPORTED]).toBe(false);
    expect(folds[BETA]).toBe(true);
  });

  it("does not let an empty project carry the open fold", () => {
    const folds = resolveSessionListFolds([candidate(ALPHA, 0), candidate(BETA, 200)], {});

    expect(folds).toEqual({ [ALPHA]: false, [BETA]: true });
  });

  it("never opens the pinned bucket in place of a project", () => {
    // The pinned rows are newer than every project, but a pin is not a place:
    // the default-open fold belongs to the latest real project.
    const folds = resolveSessionListFolds(
      [candidate("__pinned__", 500, false, true), candidate(ALPHA, 100), candidate(BETA, 200)],
      {},
    );

    expect(folds).toEqual({ __pinned__: false, [ALPHA]: false, [BETA]: true });
  });

  it("honours a remembered closed latest project", () => {
    const folds = resolveSessionListFolds([candidate(ALPHA, 200)], { [ALPHA]: false });

    expect(folds).toEqual({ [ALPHA]: false });
  });
});
