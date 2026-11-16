// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserQuestion } from "../../api/client";
import { setLocale, t } from "../../i18n";
import UserQuestionCard from "./UserQuestionCard";

/**
 * The question card asks one thing and must be answerable by mouse, keyboard
 * and number key without the card stealing a key from the controls around it.
 *
 * These tests pin the answer contract (single replaces, multi accumulates,
 * Enter belongs to the focused control) and the one-primary rule: Submit is
 * the card's only filled action and it stays disabled until there is an answer.
 */

const options = [
  { label: "Alpha", description: "The first way" },
  { label: "Beta", description: "The second way" },
];

const single: UserQuestion = {
  id: "question-1",
  task_id: "task-1",
  payload: { question: "Which approach?", options },
  status: "pending",
  created_at: 1_700_000_000_000,
};

const multi: UserQuestion = {
  ...single,
  payload: { question: "Which ones?", options, multi_select: true },
};

beforeEach(() => setLocale("en"));

function renderCard(overrides: Partial<React.ComponentProps<typeof UserQuestionCard>> = {}) {
  const onAnswer = vi.fn();
  const view = (
    <UserQuestionCard question={single} busy={false} onAnswer={onAnswer} {...overrides} />
  );
  return { ...render(view), onAnswer };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("the question card", () => {
  it("options are facade controls; single-select replaces and multi-select accumulates", async () => {
    const user = userEvent.setup();
    const first = renderCard();

    const alpha = button("Alpha");
    const beta = button("Beta");
    expect(alpha.className).toContain("kin-btn");
    expect(beta.className).toContain("kin-btn");
    expect(alpha.getAttribute("aria-pressed")).toBe("false");

    await user.click(alpha);
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    await user.click(beta);
    // Single select: choosing the second answer releases the first.
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
    expect(beta.getAttribute("aria-pressed")).toBe("true");

    first.unmount();
    renderCard({ question: multi });
    const multiAlpha = button("Alpha");
    const multiBeta = button("Beta");
    await user.click(multiAlpha);
    await user.click(multiBeta);
    expect(multiAlpha.getAttribute("aria-pressed")).toBe("true");
    expect(multiBeta.getAttribute("aria-pressed")).toBe("true");
    // Multi select: choosing an answer again releases just that one.
    await user.click(multiAlpha);
    expect(multiAlpha.getAttribute("aria-pressed")).toBe("false");
    expect(multiBeta.getAttribute("aria-pressed")).toBe("true");
  });

  it("number keys toggle the matching option only while the card is focused", () => {
    const onAnswer = vi.fn();
    const view = (focused: boolean) => (
      <UserQuestionCard question={single} focused={focused} busy={false} onAnswer={onAnswer} />
    );
    const { rerender } = render(view(false));
    const alpha = button("Alpha");

    fireEvent.keyDown(window, { key: "1" });
    expect(alpha.getAttribute("aria-pressed")).toBe("false");

    // `focused` is the card a notification named; only that card answers keys.
    rerender(view(true));
    fireEvent.keyDown(window, { key: "1" });
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
  });

  it("Enter submits from the Other input and is not stolen from a focused button", async () => {
    const user = userEvent.setup();
    const { onAnswer } = renderCard({ focused: true });

    const other = screen.getByPlaceholderText(t("question.otherPlaceholder"));
    await user.click(other);
    await user.keyboard("Ship it{Enter}");
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({ selected: [], other_text: "Ship it" });

    onAnswer.mockClear();
    const alpha = button("Alpha");
    alpha.focus();
    await user.keyboard("{Enter}");
    // Enter activated the button it was standing on; it did not answer for it.
    expect(onAnswer).not.toHaveBeenCalled();
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
  });

  it("submit is the only filled primary and stays disabled until an option or text exists", async () => {
    const user = userEvent.setup();
    const { container } = renderCard();

    const primaries = container.querySelectorAll(".kin-btn-approve");
    expect(primaries).toHaveLength(1);
    const submit = button(t("question.submit"));
    expect(submit).toBe(primaries[0]);
    expect(submit.disabled).toBe(true);

    await user.click(button("Alpha"));
    expect(submit.disabled).toBe(false);
  });

  it("busy disables options, input and submit and changes the submit label", () => {
    render(<UserQuestionCard question={single} busy onAnswer={vi.fn()} />);

    const other = screen.getByPlaceholderText(t("question.otherPlaceholder")) as HTMLInputElement;
    const submit = button(t("question.submitting"));
    expect(button("Alpha").disabled).toBe(true);
    expect(other.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.className).toContain("kin-btn-approve");
  });
});
