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
 * card's `其他` answer is a text field a person has to tap and type into, but
 * it carried no marker, so the rule could never fire for it: on a 390×844
 * phone the strip sat on the field, a real finger tap landed on the strip's
 * task name, and the typed answer went nowhere (dogfood 2026-11-25-22).
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

describe("the question card's custom answer row", () => {
  it("marks the custom answer field as a row the floating surface must not cover", () => {
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

    // It marks one row of the card, not the card's root: the options and the
    // submit button keep their own behaviour and the rule stays about the
    // field the reader types into.
    expect(row).not.toBe(view.container.firstElementChild);
  });
});
