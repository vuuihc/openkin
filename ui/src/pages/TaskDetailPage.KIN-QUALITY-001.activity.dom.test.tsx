// @vitest-environment jsdom
// KIN-QUALITY-001: new activity and failure on the reading surface. The old
// pill was an `absolute bottom-3` overlay on the table; the row now takes
// layout above the composer and a disconnect is said once, by the shell.
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import { setLocale, t } from "../i18n";
import { useAppStore } from "../store/appStore";
import {
  cleanupPage,
  detail,
  newActivityButton,
  pageTree,
  pending,
  renderPage,
  resetPage,
  store,
} from "./TaskDetailPage.KIN-QUALITY-001.harness";
const VIEWPORT = 400;
let contentHeight = 1000;
let scrollTop = 0;
function installLayout() {
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, contentHeight - VIEWPORT));
      },
    },
  });
}
const messageEvent = (seq: number) =>
  ({
    seq,
    type: "message",
    payload: { role: "assistant", speaker: "kin", text: `reply ${seq}`, model: "test-model" },
    created_at: seq,
  }) as unknown as TaskEvent;
function appendMessage() {
  act(() => store.append(messageEvent(store.state.events.length + 1)));
}
beforeEach(() => {
  resetPage();
  store.reset();
  setLocale("en");
  localStorage.clear();
  contentHeight = 1000;
  scrollTop = 0;
  installLayout();
});
afterEach(() => {
  cleanupPage();
  for (const key of ["scrollHeight", "clientHeight", "scrollTop"]) {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});
describe("TaskDetailPage KIN-QUALITY-001 activity", () => {
  it("new activity is a named button in a non-content row above the composer, not an absolute overlay", () => {
    renderPage();
    const scroller = screen.getByRole("region", { name: t("task.transcript") });
    scrollTop = 100;
    fireEvent.scroll(scroller);
    contentHeight = 1400;
    appendMessage();
    const button = newActivityButton();
    expect(button).toBeTruthy();
    expect(button!.closest(".absolute")).toBeNull();
    expect(button!.closest('[role="region"]')).toBeNull();
    expect(button!.closest("[data-kin-bottom-chrome]")).not.toBeNull();
    // A permanently mounted polite lane, and the row is flex-none — not content.
    const live = button!.closest('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live!.className.split(/\s+/)).toContain("flex-none");
    const composer = screen.getByTestId("composer");
    expect(live!.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("a failure shows one transient honest message and keeps the content", () => {
    detail.state.error = new Error("could not refresh this conversation");
    const view = renderPage();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("could not refresh this conversation");
    expect(screen.getByTestId("chat-stream")).toBeTruthy();
    expect(screen.getAllByTestId("composer")).toHaveLength(1);
    // The condition clears, and the message goes with it — no permanent block.
    detail.state.error = null;
    act(() => view.rerender(pageTree()));
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getByTestId("chat-stream")).toBeTruthy();
  });
  it("an offline message keeps the draft, the cards and the single composer", () => {
    localStorage.setItem(
      "kin_followup_draft:task-1",
      JSON.stringify({
        prompt: "half-written question",
        attachments: [],
        updatedAt: 1,
      }),
    );
    pending.state.data = {
      approvals: [
        {
          id: "ap-only",
          task_id: "task-1",
          kind: "tool_use",
          payload: { tool_name: "Write", input: { path: "a.ts" } },
          decision: "pending",
          created_at: 1,
        },
      ],
      questions: [],
    };
    useAppStore.setState({ wsStatus: "disconnected" });
    detail.state.error = new Error("connection lost");
    renderPage();
    // The shell's reconnect strip already says this; the page must not repeat it.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getByTestId("composer").getAttribute("data-draft")).toBe("half-written question");
    expect(screen.getAllByTestId("composer")).toHaveLength(1);
    expect(screen.getByTestId("chat-stream")).toBeTruthy();
    expect(document.querySelector('[data-pending-id="ap-only"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("connection lost");
  });
});
