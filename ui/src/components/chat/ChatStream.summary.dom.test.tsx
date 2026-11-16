// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

function event(
  seq: number,
  ts: number,
  type: string,
  payload: TaskEvent["payload"],
): TaskEvent {
  return { task_id: "task-summary", event_epoch: 0, seq, ts, type, payload };
}

const userMessage = (seq: number, ts: number, text: string) =>
  event(seq, ts, "message", { role: "user", content: [{ type: "text", text }] });

const note = (seq: number, ts: number, role: string, text: string) =>
  event(seq, ts, "message", {
    role,
    phase: "progress",
    speaker: "kin",
    content: [{ type: "text", text }],
    partial: false,
    visibility: { user: true, task: true },
  });

const toolCall = (seq: number, ts: number, id: string) =>
  event(seq, ts, "tool_use", {
    speaker: "kin",
    tool_use_id: id,
    name: "bash",
    input: { command: "ls" },
    visibility: { user: true, task: true },
  });

const toolResult = (seq: number, ts: number, id: string) =>
  event(seq, ts, "tool_result", {
    speaker: "kin",
    tool_use_id: id,
    name: "bash",
    output: "a.ts b.ts",
    ok: true,
    visibility: { user: true, task: true },
  });

// A finished round: a note, one tool call, and two seconds between the call
// and its result.
const settled = [
  userMessage(1, 1_000, "please fix the parser"),
  note(2, 1_000, "reasoning", "checking the parser"),
  toolCall(3, 2_000, "call-1"),
  toolResult(4, 3_000, "call-1"),
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
});

function renderStream(props: Partial<ComponentProps<typeof ChatStream>> = {}) {
  return render(<ChatStream events={settled} hostSpeaker="kin" {...props} />);
}

const header = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("button[aria-expanded]");

describe("a settled turn's summary row", () => {
  it("a settled turn is one row with state, tools and time", () => {
    const { container } = renderStream();

    const toggle = header(container);
    expect(toggle).not.toBeNull();
    // State, tool counts and elapsed time on the one header line.
    expect(toggle!.textContent).toContain(t("chat.progress.done"));
    expect(toggle!.textContent).toContain("shell × 1");
    expect(toggle!.textContent).toContain("2s");
    expect(container.querySelector("[data-progress-duration]")?.textContent).toContain("2s");

    // The latest note is one tap away with the steps, not a second ragged line.
    expect(toggle!.textContent).not.toContain("checking the parser");

    fireEvent.click(toggle!);
    expect(screen.getByText("checking the parser")).toBeTruthy();
  });

  it("a running card keeps the latest note and shows no duration", () => {
    const { container } = renderStream({ loading: true });

    // A running turn still reads its notes as body prose...
    expect(screen.getByText("checking the parser")).toBeTruthy();
    // ...and the live card never shows a number that does not tick.
    expect(container.querySelector("[data-progress-duration]")).toBeNull();
  });

  it("a run with no timestamps draws no time", () => {
    const unstamped = [
      userMessage(1, 0, "please fix the parser"),
      note(2, 0, "reasoning", "checking the parser"),
      toolCall(3, 0, "call-1"),
      toolResult(4, 0, "call-1"),
    ];
    const { container } = render(<ChatStream events={unstamped} hostSpeaker="kin" />);

    expect(header(container)).not.toBeNull();
    expect(container.querySelector("[data-progress-duration]")).toBeNull();
    expect(container.textContent).not.toContain("<1s");
  });
});
