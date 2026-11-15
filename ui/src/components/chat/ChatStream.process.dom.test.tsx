// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

function event(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-process", event_epoch: 0, seq, ts: seq, type, payload };
}

const userMessage = (seq: number, text: string) =>
  event(seq, "message", { role: "user", content: [{ type: "text", text }] });

const reasoning = (seq: number, text: string) =>
  event(seq, "message", {
    role: "reasoning",
    phase: "progress",
    speaker: "kin",
    text,
    partial: false,
    visibility: { user: true, task: true },
  });

const narration = (seq: number, text: string) =>
  event(seq, "message", {
    role: "assistant",
    phase: "progress",
    speaker: "kin",
    text,
    partial: false,
    visibility: { user: true, task: true },
  });

const summary = (seq: number, text: string) =>
  event(seq, "message", {
    role: "assistant",
    phase: "summary",
    speaker: "kin",
    text,
    partial: false,
    visibility: { user: true, task: true },
  });

const toolUse = (seq: number, id: string, name: string, input: unknown) =>
  event(seq, "tool_use", {
    speaker: "kin",
    tool_use_id: id,
    name,
    input,
    visibility: { user: true, task: true },
  });

const toolResult = (seq: number, id: string, name: string, output: string) =>
  event(seq, "tool_result", {
    speaker: "kin",
    tool_use_id: id,
    name,
    output,
    ok: true,
    visibility: { user: true, task: true },
  });

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as Element["scrollIntoView"];
});

const findInput = () => screen.getByRole("textbox", { name: t("chat.find.label") });
const activeRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-message-key][data-find-active="true"]');

describe("process text outside tool cards", () => {
  const liveEvents = [
    userMessage(1, "please trace the render path"),
    reasoning(2, "Inspecting the repository."),
    toolUse(3, "call-1", "bash", { command: "ls" }),
    toolResult(4, "call-1", "bash", "ChatStream.tsx"),
    narration(5, "Located the rendering path."),
  ];

  it("shows live reasoning and progress narration outside collapsed tool cards", () => {
    const { container } = render(
      <ChatStream events={liveEvents} hostSpeaker="kin" loading />,
    );

    // The process text reads in the column without opening anything.
    const reasoningRow = screen.getByText("Inspecting the repository.");
    expect(reasoningRow.closest("button")).toBeNull();
    const narrationRow = screen.getByText("Located the rendering path.");
    expect(narrationRow.closest("button")).toBeNull();

    // The call is still a card, folded by default.
    const card = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(card).not.toBeNull();
    fireEvent.click(card as HTMLButtonElement);

    // The tool's own row and its payload stay behind that one fold.
    const toolRow = screen.getAllByRole("button", { name: /shell/ }).at(-1);
    fireEvent.click(toolRow as HTMLButtonElement);
    expect(screen.getByText(/"command": "ls"/)).toBeTruthy();
    expect(screen.getByText("ChatStream.tsx")).toBeTruthy();

    // Expanding the call did not move the text into the card.
    expect(screen.getByText("Inspecting the repository.").closest("button")).toBeNull();
    expect(screen.getByText("Located the rendering path.").closest("button")).toBeNull();
  });

  it("find still reveals a process note after the turn folds", () => {
    const foldedEvents = [
      userMessage(1, "please look at the parser"),
      toolUse(2, "call-1", "bash", { command: "ls" }),
      toolResult(3, "call-1", "bash", "parser.ts"),
      reasoning(4, "the needle is in this note"),
      summary(5, "The parser is fixed."),
    ];
    const { container } = render(<ChatStream events={foldedEvents} hostSpeaker="kin" />);

    // Settled: the whole process is behind the card's fold. The collapsed
    // preview may quote the note, but the note's own row is not drawn.
    expect(container.querySelector('[data-message-key="note-4"]')).toBeNull();

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "needle" } });

    expect(screen.getByText(t("chat.find.count", { index: 1, total: 1 }))).toBeTruthy();
    const active = activeRow(container);
    expect(active?.getAttribute("data-message-key")).toBe("note-4");
    expect(active?.textContent).toContain("the needle is in this note");
    expect(scrollSpy.mock.instances.at(-1)).toBe(active);
    // The final answer stays the visible conclusion beside the folded summary.
    expect(screen.getByText("The parser is fixed.")).toBeTruthy();
  });
});
