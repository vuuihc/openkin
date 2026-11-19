// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskEvent } from "../../api/client";
import { setLocale, t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * The transcript's quiet pass: one wait cue, narration with no label, and a
 * folded tool card that reads as one sentence instead of a status chip, a
 * summary and a fold label saying the same thing three ways.
 */

function event(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-quiet", event_epoch: 0, seq, ts: seq * 1_000, type, payload };
}

const userMessage = (seq: number, text: string) =>
  event(seq, "message", { role: "user", content: [{ type: "text", text }] });

const note = (seq: number, role: string, text: string) =>
  event(seq, "message", {
    role,
    phase: "progress",
    speaker: "kin",
    content: [{ type: "text", text }],
    partial: false,
    visibility: { user: true, task: true },
  });

const toolCall = (seq: number, id: string) =>
  event(seq, "tool_use", {
    speaker: "kin",
    tool_use_id: id,
    name: "bash",
    input: { command: "ls" },
    visibility: { user: true, task: true },
  });

const toolResult = (seq: number, id: string, ok = true) =>
  event(seq, "tool_result", {
    speaker: "kin",
    tool_use_id: id,
    name: "bash",
    output: ok ? "a.ts b.ts" : "ERROR: no such file",
    ok,
    visibility: { user: true, task: true },
  });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
});

function renderStream(events: TaskEvent[], props: Partial<ComponentProps<typeof ChatStream>> = {}) {
  return render(<ChatStream events={events} hostSpeaker="kin" {...props} />);
}

/** The card's one disclosure control: the button that reports aria-expanded. */
const disclosure = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("button[aria-expanded]");

const dotsInside = (element: HTMLElement) => element.querySelectorAll(".kin-dot").length;

describe("one wait cue", () => {
  it("waits with one visible cue", () => {
    setLocale("en");
    // The standalone wait: a user message, nothing back yet.
    const { container } = renderStream([userMessage(1, "hello")], { loading: true });

    expect(container.textContent).not.toContain(t("chat.thinking"));
    const cues = screen.getAllByRole("status", { name: t("chat.thinking") });
    expect(cues).toHaveLength(1);
    expect(dotsInside(cues[0])).toBe(3);
  });
});

describe("a narration note", () => {
  it("a narration note shows no label", () => {
    setLocale("en");
    const events = [
      userMessage(1, "please fix the parser"),
      note(2, "assistant", "the parser is fine"),
    ];
    const { container } = renderStream(events, { loading: true });

    const row = container.querySelector<HTMLElement>('[data-message-key="note-2"]');
    expect(row).not.toBeNull();
    // The text and its status dot stay...
    expect(row!.textContent).toContain("the parser is fine");
    expect(row!.querySelector("span.bg-kin-green")).not.toBeNull();
    // ...and there is no word in front of it: no "note", no 「过程」.
    expect(row!.textContent?.trim()).toBe("the parser is fine");
  });

  it("a reasoning note still says who it is", () => {
    setLocale("en");
    const events = [
      userMessage(1, "please fix the parser"),
      note(2, "reasoning", "checking the parser"),
    ];
    const { container } = renderStream(events, { loading: true });

    const row = container.querySelector<HTMLElement>('[data-message-key="note-2"]');
    expect(row!.textContent).toContain(t("chat.progress.thinking"));
    expect(row!.textContent).toContain("checking the parser");
  });
});

describe("a folded tool card", () => {
  it("a settled tool card is one sentence", () => {
    setLocale("en");
    const events = [
      userMessage(1, "run it"),
      toolCall(2, "call-1"),
      toolResult(3, "call-1"),
      toolCall(4, "call-2"),
      toolResult(5, "call-2"),
    ];
    const { container } = renderStream(events);

    const toggle = disclosure(container);
    expect(toggle).not.toBeNull();
    expect(toggle!.tagName).toBe("BUTTON");
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    // One sentence, in the past tense, naming the tool and the count.
    expect(toggle!.textContent).toContain("Called shell × 2");
    // None of the old furniture: no state chip, no "steps collapsed" label.
    expect(toggle!.textContent).not.toContain("done");
    expect(toggle!.textContent).not.toContain("steps collapsed");

    fireEvent.click(toggle!);
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("shell")).toHaveLength(2);

    fireEvent.click(toggle!);
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("shell")).toBeNull();
  });

  it("a running card is one present-tense line", () => {
    setLocale("en");
    const events = [userMessage(1, "run it"), toolCall(2, "call-1")];
    const { container } = renderStream(events, { loading: true });

    const toggle = disclosure(container);
    expect(toggle!.textContent).toContain("Calling shell…");
    expect(toggle!.querySelector(".animate-breathe")).not.toBeNull();
  });

  it("a failed call still says so", () => {
    setLocale("en");
    const events = [
      userMessage(1, "run it"),
      toolCall(2, "call-1"),
      toolResult(3, "call-1", false),
    ];
    const { container } = renderStream(events);

    const toggle = disclosure(container);
    expect(toggle!.textContent).toContain("1 failed");
    const dot = toggle!.querySelector<HTMLElement>('[data-progress-state="failed"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain("bg-kin-red");
  });
});
