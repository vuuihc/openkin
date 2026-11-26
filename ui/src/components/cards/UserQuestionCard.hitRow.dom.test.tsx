// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserQuestion } from "../../api/client";
import { setLocale, t } from "../../i18n";
import UserQuestionCard from "./UserQuestionCard";

/**
 * The producer half of the floating approval's yield rule.
 *
 * `FloatingApproval` measures every `[data-kin-hit-row]` box before it draws
 * the decision card, and gives the card up when one is under it. A question
 * card's `其他` answer is a text field a person has to tap and type into, and
 * the submit row is the only way to send it, but neither carried the marker:
 * on a 390×844 phone the strip sat on the field and a real finger tap landed
 * on the strip's task name, and at 820 the expanded card covered the field and
 * clipped 提交. Both rows now carry the same unscoped marker every other
 * interactive row in the stream uses, so the yield holds at every width.
 */

const question: UserQuestion = {
  id: "question-1",
  task_id: "task-1",
  payload: {
    question: "Which release path?",
    options: [
      { label: "Alpha", description: "The first way" },
      { label: "Beta", description: "The second way" },
    ],
  },
  status: "pending",
  created_at: 1_700_000_000_000,
};

beforeEach(() => setLocale("en"));

describe("the question card's footer", () => {
  it("marks the custom answer row as a row the floating surface must not cover", () => {
    const view = render(<UserQuestionCard question={question} onAnswer={vi.fn()} />);
    const input = screen.getByPlaceholderText(t("question.otherPlaceholder"));

    // The marker is on the row a person taps, not on the input alone: the
    // label sits in the same row, and a tap on that row is the same intent.
    const row = input.closest("[data-kin-hit-row]");
    expect(row).not.toBeNull();
    expect(row).not.toBe(input);
    expect(row?.tagName).toBe("DIV");
    expect(row?.contains(input)).toBe(true);
    expect(row?.textContent).toContain(t("question.other"));
    // The shared unscoped marker — the same attribute value a changed-file row
    // and a conversation row carry — not a width- or surface-specific one.
    expect(row?.getAttribute("data-kin-hit-row")).toBe("");

    // It marks one row of the card, not the card's root: the options keep their
    // own behaviour and the rule stays about the controls the reader taps.
    expect(row).not.toBe(view.container.firstElementChild);
  });

  it("marks the submit row as a row the floating surface must not cover", () => {
    // The 820 gate reading: the expanded decision card clipped the bottom of
    // 提交, the only filled action that sends the answer. The submit row is a
    // control exactly like the field above it, so it carries the same marker.
    const view = render(<UserQuestionCard question={question} onAnswer={vi.fn()} />);
    const submit = screen.getByRole("button", { name: t("question.submit") });
    const row = submit.closest("[data-kin-hit-row]");

    expect(row).not.toBeNull();
    expect(row?.contains(submit)).toBe(true);
    expect(row?.getAttribute("data-kin-hit-row")).toBe("");
    // A row of its own: not the answer field's row, and not the card's root.
    expect(row).not.toBe(
      screen.getByPlaceholderText(t("question.otherPlaceholder")).closest("[data-kin-hit-row]"),
    );
    expect(row).not.toBe(view.container.firstElementChild);
  });
});
