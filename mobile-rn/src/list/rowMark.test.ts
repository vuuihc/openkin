import { describe, expect, it } from "@jest/globals";
import { rowMark } from "./rowMark";

/**
 * KIN-MOBILE-002 R3 — the row's status mark, decided without a renderer.
 *
 * The mark is shape + colour double-coded (`mobile-rn/DESIGN.md`: 蓝点运行、
 * 橙三角待批带计数、红方块失败、灰点已完成). An approval outranks every
 * status: a running task that is also waiting on the person is the row the eye
 * must land on first.
 */

describe("KIN-MOBILE-002 R3 row mark", () => {
  it("KIN-MOBILE-002 R3: a pending approval outranks every status and marks a triangle", () => {
    expect(rowMark({ status: "running", pending: 2 })).toEqual({
      shape: "triangle",
      tone: "orange",
    });
    expect(rowMark({ status: "failed", pending: 1 })).toEqual({
      shape: "triangle",
      tone: "orange",
    });
    expect(rowMark({ status: "waiting_approval", pending: 3 })).toEqual({
      shape: "triangle",
      tone: "orange",
    });
    expect(rowMark({ status: null, pending: 1 })).toEqual({
      shape: "triangle",
      tone: "orange",
    });
  });

  it("KIN-MOBILE-002 R3: running is a blue dot, failed a red square, canceled a grey square, succeeded a grey dot", () => {
    expect(rowMark({ status: "running", pending: 0 })).toEqual({
      shape: "dot",
      tone: "blue",
    });
    expect(rowMark({ status: "failed", pending: 0 })).toEqual({
      shape: "square",
      tone: "red",
    });
    expect(rowMark({ status: "canceled", pending: 0 })).toEqual({
      shape: "square",
      tone: "grey",
    });
    expect(rowMark({ status: "succeeded", pending: 0 })).toEqual({
      shape: "dot",
      tone: "grey",
    });
  });

  it("KIN-MOBILE-002 R3: a null status draws no mark", () => {
    expect(rowMark({ status: null, pending: 0 })).toEqual({
      shape: "none",
      tone: "grey",
    });
    // A status the vocabulary does not draw (for example a waiting row whose
    // approval has not reached this read yet) is not an invented mark either.
    expect(rowMark({ status: "waiting_approval", pending: 0 })).toEqual({
      shape: "none",
      tone: "grey",
    });
    expect(rowMark({ status: "waiting_input", pending: 0 })).toEqual({
      shape: "none",
      tone: "grey",
    });
  });
});
