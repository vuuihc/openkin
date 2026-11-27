/**
 * KIN-MOBILE-002 R3 — a conversation row's status mark, decided without a
 * renderer.
 *
 * The design double-codes status as shape + colour (`mobile-rn/DESIGN.md`:
 * 蓝点运行、橙三角待批带计数、红方块失败、灰点已完成), so the list is
 * readable in a glance and never relies on colour alone. The decision table,
 * in this order:
 *
 *   1. `pending > 0`            → triangle / orange  (an approval outranks all)
 *   2. `status === "running"`   → dot / blue
 *   3. `status === "failed"`    → square / red
 *   4. `status === "canceled"`  → square / grey
 *   5. `status === "succeeded"` → dot / grey
 *   6. otherwise (null or a status this vocabulary does not draw) → no mark
 *
 * The shape is decorative: the row's accessibility label already carries the
 * signed status word, so the mark may hide itself from the screen reader.
 */

export type MarkShape = "dot" | "triangle" | "square" | "none";

export type MarkTone = "blue" | "orange" | "red" | "grey";

export type RowMark = { shape: MarkShape; tone: MarkTone };

/** The raw task status a row carries, or null when it has none. */
export type MarkableRow = {
  status: string | null;
  pending: number;
};

export function rowMark(row: Pick<MarkableRow, "status" | "pending">): RowMark {
  if (row.pending > 0) return { shape: "triangle", tone: "orange" };
  switch (row.status) {
    case "running":
      return { shape: "dot", tone: "blue" };
    case "failed":
      return { shape: "square", tone: "red" };
    case "canceled":
      return { shape: "square", tone: "grey" };
    case "succeeded":
      return { shape: "dot", tone: "grey" };
    default:
      // No status, or one with no drawn mark (waiting_* without a received
      // approval): the row stays unmarked rather than inventing a shape.
      return { shape: "none", tone: "grey" };
  }
}
