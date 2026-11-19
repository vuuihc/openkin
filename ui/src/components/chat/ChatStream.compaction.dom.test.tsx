// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * A context compaction at the seam the console consumes it: the ACP adapter
 * emits `compaction_summary_chunk` as partial `phase: "compaction"` messages
 * (internal/adapter/acp/update.go), and `compaction_update` as a
 * `context compacted` notice. The reader should see one quiet disclosure line,
 * with the summary complete behind it — never an agent-shaped bubble.
 */

function event(seq: number, ts: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-compaction", event_epoch: 0, seq, ts, type, payload };
}

const SUMMARY_FIRST =
  "The messages after this summary are the most recent messages from before compaction, kept verbatim.";
const SUMMARY_LAST = "Everything before that was folded into the summary above.";
const SUMMARY = `${SUMMARY_FIRST} ${SUMMARY_LAST}`;

const userMessage = (seq: number, ts: number, text: string) =>
  event(seq, ts, "message", { role: "user", content: [{ type: "text", text }] });

const compactionChunk = (seq: number, ts: number, text: string) =>
  event(seq, ts, "message", {
    role: "assistant",
    speaker: "kin",
    phase: "compaction",
    partial: true,
    content: [{ type: "text", text }],
    visibility: { user: true, task: true },
  });

const compactionFinal = (seq: number, ts: number, text: string) =>
  event(seq, ts, "message", {
    role: "assistant",
    speaker: "kin",
    phase: "compaction",
    partial: false,
    content: [{ type: "text", text }],
    visibility: { user: true, task: true },
  });

const compactionNotice = (seq: number, ts: number) =>
  event(seq, ts, "notice", {
    speaker: "acp",
    severity: "info",
    title: "context compacted",
    message: "",
  });

const assistantMessage = (seq: number, ts: number, text: string) =>
  event(seq, ts, "message", {
    role: "assistant",
    speaker: "kin",
    partial: false,
    content: [{ type: "text", text }],
    visibility: { user: true, task: true },
  });

const settledEvents = [
  userMessage(1, 1_000, "please fix the parser"),
  compactionChunk(2, 2_000, SUMMARY_FIRST),
  compactionFinal(3, 3_000, SUMMARY),
  assistantMessage(4, 4_000, "Fixed the parser."),
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  // Message rows consult the phone breakpoint before revealing their actions.
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({
      matches: false,
      media: "(max-width: 639px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
  });
});

function renderStream(events: TaskEvent[], props: Partial<ComponentProps<typeof ChatStream>> = {}) {
  return render(<ChatStream events={events} hostSpeaker="kin" {...props} />);
}

const hints = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-compaction-hint]"));

const hintButton = (container: HTMLElement) =>
  hints(container)[0]?.querySelector<HTMLButtonElement>("button") ?? null;

describe("context compaction in the transcript", () => {
  it("a settled compaction draws one collapsed hint and not the summary", () => {
    const { container } = renderStream(settledEvents);

    const rows = hints(container);
    expect(rows).toHaveLength(1);
    const button = hintButton(container);
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-expanded")).toBe("false");
    expect(button!.textContent).toContain(t("chat.compaction.show"));

    // Collapsed is not "the summary as a bubble": neither sentence is in the
    // DOM until the reader asks for it.
    expect(container.textContent).not.toContain(SUMMARY_FIRST);
    expect(container.textContent).not.toContain(SUMMARY_LAST);
  });

  it("expanding the hint reveals the whole summary", () => {
    const { container } = renderStream(settledEvents);

    fireEvent.click(hintButton(container)!);

    expect(hintButton(container)!.getAttribute("aria-expanded")).toBe("true");
    // Complete, not a preview: the first and last sentence are both there.
    expect(container.textContent).toContain(SUMMARY_FIRST);
    expect(container.textContent).toContain(SUMMARY_LAST);

    // The summary is a page-long block; the box scrolls, and a keyboard user
    // must be able to focus it to scroll what is past the fold.
    const region = hints(container)[0].querySelector<HTMLElement>('[role="region"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute("tabindex")).toBe("0");
    expect(region!.getAttribute("aria-label")).toBe(t("chat.compaction.label"));
    expect(region!.textContent).toContain(SUMMARY_LAST);
  });

  it("a streaming compaction says it is compacting, with no half summary", () => {
    const { container } = renderStream(
      [userMessage(1, 1_000, "please fix the parser"), compactionChunk(2, 2_000, SUMMARY_FIRST)],
      { loading: true },
    );

    const running = screen.getByText(t("chat.compaction.running"));
    expect(running).toBeTruthy();
    // It is the status line for this moment, not decoration: a polite live
    // region, since the generic thinking row is suppressed while it runs.
    expect(hints(container)[0].getAttribute("aria-live")).toBe("polite");
    expect(container.textContent).not.toContain(SUMMARY_FIRST);
    expect(hints(container)).toHaveLength(1);
    // One moment, one cue: the generic thinking row would be a second hint.
    expect(screen.queryByLabelText(t("chat.thinking"))).toBeNull();
    expect(screen.queryByText(t("chat.thinking"))).toBeNull();
  });

  it("one compaction never draws two hints", () => {
    const { container } = renderStream([
      userMessage(1, 1_000, "please fix the parser"),
      compactionChunk(2, 2_000, SUMMARY_FIRST),
      compactionNotice(3, 3_000),
      compactionFinal(4, 4_000, SUMMARY),
      compactionNotice(5, 5_000),
      assistantMessage(6, 6_000, "Fixed the parser."),
    ]);

    expect(hints(container)).toHaveLength(1);
    // The adapter's own notice is not a second caption. Compared as a whole
    // line, not a substring: the settled label legitimately contains the same
    // words, and this test must not depend on which locale is the default.
    const captions = Array.from(container.querySelectorAll("p")).map((p) =>
      (p.textContent ?? "").trim().toLowerCase(),
    );
    expect(captions).not.toContain("context compacted");
  });

  it("draws a compaction inside the agent column, still as one line", () => {
    const { container } = renderStream([
      userMessage(1, 1_000, "please fix the parser"),
      event(2, 2_000, "tool_use", {
        speaker: "kin",
        tool_use_id: "call-1",
        name: "bash",
        input: { command: "ls" },
        visibility: { user: true, task: true },
      }),
      event(3, 3_000, "tool_result", {
        speaker: "kin",
        tool_use_id: "call-1",
        name: "bash",
        output: "a.ts",
        ok: true,
        visibility: { user: true, task: true },
      }),
      compactionChunk(4, 4_000, SUMMARY_FIRST),
      compactionFinal(5, 5_000, SUMMARY),
      assistantMessage(6, 6_000, "Fixed the parser."),
    ]);

    // The compaction follows the tool card, so it lands in the agent turn
    // rather than a standalone row — the other branch that draws it.
    expect(hints(container)).toHaveLength(1);
    expect(hintButton(container)!.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain(SUMMARY_FIRST);
    fireEvent.click(hintButton(container)!);
    expect(container.textContent).toContain(SUMMARY_LAST);
  });

  it("draws a line, not a dead disclosure, when the summary is missing", () => {
    const { container } = renderStream([
      userMessage(1, 1_000, "please fix the parser"),
      compactionNotice(2, 2_000),
      event(3, 3_000, "result", { is_error: false }),
    ]);

    expect(hints(container)).toHaveLength(1);
    expect(hints(container)[0].textContent).toContain(t("chat.compaction.label"));
    expect(hints(container)[0].querySelector("button")).toBeNull();
    expect(hints(container)[0].querySelector("[aria-expanded]")).toBeNull();
  });

  it("a compaction is not selectable and not findable", () => {
    const { container } = renderStream(settledEvents);

    // Find: the summary is behind a disclosure, not transcript prose.
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: t("chat.find.label") }), {
      target: { value: SUMMARY_FIRST },
    });
    expect(screen.getByText(t("chat.find.noMatches"))).toBeTruthy();

    // Share selection: only the real answer is a selectable message.
    fireEvent.click(screen.getByRole("button", { name: t("chat.message.shareTitle") }));
    expect(screen.getByRole("region", { name: t("chat.message.selection") })).toBeTruthy();
    // The ask and the answer are selectable; the summary behind the disclosure
    // is not a message and gets no checkbox.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(hints(container)[0].querySelector('[role="checkbox"]')).toBeNull();
  });
});
