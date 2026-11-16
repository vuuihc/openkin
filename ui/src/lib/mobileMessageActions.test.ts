// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  isMessageActionsToggleTap,
  toggleMobileMessageActions,
  useMobileMessageActionsRevealed,
} from "./mobileMessageActions";

describe("mobileMessageActions", () => {
  it("reveals one message at a time and hides on a second tap", () => {
    const a = renderHook(() => useMobileMessageActionsRevealed("msg-a"));
    const b = renderHook(() => useMobileMessageActionsRevealed("msg-b"));
    expect(a.result.current).toBe(false);
    expect(b.result.current).toBe(false);

    act(() => toggleMobileMessageActions("msg-a"));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(false);

    // Revealing another hides the previous one.
    act(() => toggleMobileMessageActions("msg-b"));
    expect(a.result.current).toBe(false);
    expect(b.result.current).toBe(true);

    // Tapping the same message again hides it.
    act(() => toggleMobileMessageActions("msg-b"));
    expect(b.result.current).toBe(false);

    a.unmount();
    b.unmount();
  });

  it("ignores toggling the same key twice without subscribers churning", () => {
    const a = renderHook(() => useMobileMessageActionsRevealed("msg-a"));
    act(() => toggleMobileMessageActions("msg-a"));
    act(() => toggleMobileMessageActions("msg-a"));
    expect(a.result.current).toBe(false);
    a.unmount();
  });

  it("keeps same-named messages in different scopes independent", () => {
    // Message keys are `t-<seq>` and seq restarts per task; several sessions
    // stay mounted (the tab host), so the caller scopes the key by task id.
    const taskA = renderHook(() => useMobileMessageActionsRevealed("task-a:t-3"));
    const taskB = renderHook(() => useMobileMessageActionsRevealed("task-b:t-3"));
    act(() => toggleMobileMessageActions("task-a:t-3"));
    expect(taskA.result.current).toBe(true);
    expect(taskB.result.current).toBe(false);
    act(() => toggleMobileMessageActions("task-b:t-3"));
    expect(taskA.result.current).toBe(false);
    expect(taskB.result.current).toBe(true);
    taskA.unmount();
    taskB.unmount();
  });

  it("does not treat a tap on a control or link as a reveal toggle", () => {
    document.body.innerHTML =
      '<div data-message><button id="b">copy</button><a id="l" href="#">link</a></div>';
    const button = document.getElementById("b")!;
    const link = document.getElementById("l")!;
    const div = document.querySelector("[data-message]")!;
    expect(isMessageActionsToggleTap(button)).toBe(false);
    expect(isMessageActionsToggleTap(link)).toBe(false);
    expect(isMessageActionsToggleTap(div)).toBe(true);
  });

  it("does not reveal while a text selection is live", () => {
    document.body.innerHTML = "<p id='p'>hello world</p>";
    const p = document.getElementById("p")!;
    expect(isMessageActionsToggleTap(p)).toBe(true);
    // A non-collapsed selection means the user is selecting text.
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 5);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.isCollapsed).toBe(false);
    expect(isMessageActionsToggleTap(p)).toBe(false);
    sel.removeAllRanges();
    document.body.innerHTML = "";
  });
});
