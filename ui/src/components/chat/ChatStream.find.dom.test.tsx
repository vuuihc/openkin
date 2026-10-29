// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

function event(seq: number, type: string, payload: unknown): TaskEvent {
  return { task_id: "task-find", event_epoch: 0, seq, ts: seq, type, payload };
}

const userMessage = (seq: number, text: string) =>
  event(seq, "message", { role: "user", content: [{ type: "text", text }] });

const assistantMessage = (seq: number, text: string, messageId: string) =>
  event(seq, "message", {
    role: "assistant",
    speaker: "kin",
    content: [{ type: "text", text }],
    partial: false,
    message_id: messageId,
    index: 0,
  });

const events = [
  userMessage(1, "please fix the parser"),
  assistantMessage(2, "the parser is fixed", "m1"),
  userMessage(3, "thanks"),
];

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as Element["scrollIntoView"];
});

function renderStream(props: Partial<ComponentProps<typeof ChatStream>> = {}) {
  return render(<ChatStream events={events} hostSpeaker="kin" {...props} />);
}

const findInput = () => screen.getByRole("textbox", { name: t("chat.find.label") });
const nextButton = () => screen.getByRole("button", { name: t("chat.find.next") });
const prevButton = () => screen.getByRole("button", { name: t("chat.find.prev") });
const activeRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-message-key][data-find-active="true"]');

/** Escape closes on a task boundary (see ChatStream), so let it run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("find in conversation", () => {
  it("opens on the platform shortcut and closes on Escape", async () => {
    renderStream();
    expect(screen.queryByRole("search")).toBeNull();

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByRole("search")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("opens on Ctrl+F as well, for the non-Mac keyboards", () => {
    renderStream();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("search")).toBeTruthy();
  });

  it("does not open over a key another handler already claimed", () => {
    renderStream();
    // A handler closer to the key than the window — Monaco's own find inside
    // the editor, or a dialog's shortcut — claims it on the way up. The bar is
    // a window listener, so without the flag it would open on top of whatever
    // just handled the key.
    const claim = (event: KeyboardEvent) => event.preventDefault();
    document.body.addEventListener("keydown", claim);
    try {
      fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    } finally {
      document.body.removeEventListener("keydown", claim);
    }
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("leaves Escape to an inner surface that already claimed it", async () => {
    renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByRole("search")).toBeTruthy();

    // A mention menu, the command palette or a sheet: it answers this Escape.
    const claim = (event: KeyboardEvent) => event.preventDefault();
    document.body.addEventListener("keydown", claim);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await settle();
    document.body.removeEventListener("keydown", claim);

    expect(screen.getByRole("search")).toBeTruthy();
  });

  it("clears the mark when it closes, and reopens on the same query", async () => {
    const { container } = renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "parser" } });
    expect(activeRow(container)).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    // A ring left behind marks a message the reader is no longer searching.
    expect(activeRow(container)).toBeNull();

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect((findInput() as HTMLInputElement).value).toBe("parser");
    expect(screen.getByText(t("chat.find.count", { index: 1, total: 2 }))).toBeTruthy();
  });

  it("counts the matches and marks the first one", () => {
    const { container } = renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "parser" } });

    expect(screen.getByText(t("chat.find.count", { index: 1, total: 2 }))).toBeTruthy();
    expect(activeRow(container)?.textContent).toContain("please fix the parser");
  });

  it("steps through matches, wraps, and scrolls to each one", () => {
    const { container } = renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "parser" } });

    fireEvent.click(nextButton());
    expect(screen.getByText(t("chat.find.count", { index: 2, total: 2 }))).toBeTruthy();
    expect(activeRow(container)?.textContent).toContain("the parser is fixed");
    expect(scrollSpy).toHaveBeenLastCalledWith({ block: "center", behavior: "smooth" });
    expect(scrollSpy.mock.instances.at(-1)).toBe(activeRow(container));

    // The last match steps forward to the first rather than dead-ending.
    fireEvent.click(nextButton());
    expect(screen.getByText(t("chat.find.count", { index: 1, total: 2 }))).toBeTruthy();
    // ...and backwards off the first lands on the last.
    fireEvent.click(prevButton());
    expect(screen.getByText(t("chat.find.count", { index: 2, total: 2 }))).toBeTruthy();
  });

  it("steps with Enter and Shift+Enter from the field", () => {
    renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "parser" } });

    fireEvent.keyDown(findInput(), { key: "Enter" });
    expect(screen.getByText(t("chat.find.count", { index: 2, total: 2 }))).toBeTruthy();
    fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });
    expect(screen.getByText(t("chat.find.count", { index: 1, total: 2 }))).toBeTruthy();
  });

  it("re-centres on next even when there is only one match", () => {
    renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "thanks" } });
    expect(screen.getByText(t("chat.find.count", { index: 1, total: 1 }))).toBeTruthy();

    // The ordinal does not change, so only a step counter can bring the reader
    // back to the one match they scrolled away from.
    const before = scrollSpy.mock.calls.length;
    fireEvent.click(nextButton());
    expect(scrollSpy.mock.calls.length).toBe(before + 1);
  });

  it("ignores an Enter that only confirms an IME candidate", () => {
    renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "parser" } });

    fireEvent.keyDown(findInput(), { key: "Enter", isComposing: true });
    expect(screen.getByText(t("chat.find.count", { index: 1, total: 2 }))).toBeTruthy();
  });

  it("says so when nothing matches, instead of pointing at nothing", () => {
    const { container } = renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "zzz" } });

    expect(screen.getByText(t("chat.find.noMatches"))).toBeTruthy();
    expect(activeRow(container)).toBeNull();
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    expect((prevButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("returns to the first match when the query changes", () => {
    renderStream();
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "the" } });
    fireEvent.click(nextButton());
    expect(screen.getByText(t("chat.find.count", { index: 2, total: 2 }))).toBeTruthy();

    // Both messages still match; the walk restarts rather than staying on #2.
    fireEvent.change(findInput(), { target: { value: "fi" } });
    expect(screen.getByText(t("chat.find.count", { index: 1, total: 2 }))).toBeTruthy();
  });

  it("does not let a keep-alive-hidden pane claim the shortcut", () => {
    renderStream({ findShortcut: false });
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("does not handle Escape in a hidden pane either", async () => {
    const onFindOpenChange = vi.fn();
    renderStream({ findOpen: true, onFindOpenChange, findShortcut: false });
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(onFindOpenChange).not.toHaveBeenCalled();
  });

  it("opens from a controlled parent, which is how the phone's menu does it", async () => {
    const onFindOpenChange = vi.fn();
    renderStream({ findOpen: true, onFindOpenChange });

    expect(screen.getByRole("search")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(onFindOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: t("chat.find.close") }));
    expect(onFindOpenChange).toHaveBeenCalledWith(false);
  });
});
