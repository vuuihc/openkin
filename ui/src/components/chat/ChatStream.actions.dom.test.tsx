// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

/**
 * C4a parity guards: the conversation's controls moved onto the shared facade,
 * and these are the behaviours the move must not have changed. They pass on
 * either side of the migration on purpose — the facade swap is the change, not
 * a new feature — and the slice's mutant manifest proves two of them are
 * load-bearing.
 */

function event(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-actions", event_epoch: 0, seq, ts: seq, type, payload };
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

let writeText: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;

/**
 * Answer the two queries the message row asks: the phone breakpoint and the
 * pointer kind. A platform the stub does not name answers `false`, which keeps
 * every other suite in its shipped desktop shape.
 */
function stubMedia({ phone = false, coarse = false }: { phone?: boolean; coarse?: boolean } = {}) {
  const answer = (query: string) =>
    query.includes("pointer: coarse") ? coarse : query.includes("max-width: 639px") ? phone : false;
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((query: string) => ({
      matches: answer(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
  });
}

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  createObjectURL = vi.fn(() => "blob:kin-share");
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
  });
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  // The message row's tap handler reads the phone breakpoint and the pointer
  // kind before deciding whether a tap reveals the action row. The default is
  // a mouse at desktop width, so the reveal stays out of the way.
  stubMedia();
});

function renderStream(props: Partial<ComponentProps<typeof ChatStream>> = {}) {
  return render(<ChatStream events={events} hostSpeaker="kin" {...props} />);
}

describe("message actions", () => {
  it("retry and fork appear only when the caller offers them, and pass the message seq", () => {
    const onRetry = vi.fn();
    const onFork = vi.fn();
    const view = renderStream({ showMessageActions: true, onRetry, onFork });

    fireEvent.click(screen.getByRole("button", { name: t("task.retry") }));
    expect(onRetry).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: t("task.fork") }));
    expect(onFork).toHaveBeenCalledWith(2);

    view.unmount();
    renderStream();
    expect(screen.queryByRole("button", { name: t("task.retry") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("task.fork") })).toBeNull();
  });

  it("copy and share keep their names and pass the message text/key", async () => {
    renderStream();

    const copy = screen.getByRole("button", { name: t("chat.message.copyTitle") });
    expect(copy.getAttribute("title")).toBe(t("chat.message.copyTitle"));
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the parser is fixed"));

    // Share takes the message's key: the bar it opens is selecting exactly that
    // one message, which the bar's own copy then proves by carrying its text.
    const share = screen.getByRole("button", { name: t("chat.message.shareTitle") });
    expect(share.getAttribute("title")).toBe(t("chat.message.shareTitle"));
    fireEvent.click(share);

    expect(screen.getByRole("region", { name: t("chat.message.selection") })).toBeTruthy();
    expect(screen.getByText(t("chat.message.selected", { count: 1 }))).toBeTruthy();
  });
});

describe("the actions reveal on a coarse pointer", () => {
  const row = () => screen.getByRole("group", { name: t("task.actions") });
  const body = () => screen.getByText("the parser is fixed");

  it("a coarse pointer at tablet width reveals the actions on a body tap and hides them on a second tap", () => {
    // The dogfood case: an iPad at 820 has a coarse pointer and no hover, but
    // the desktop layout. The row rests hidden and a body tap is its only way
    // in; the tap must not press anything.
    stubMedia({ coarse: true, phone: false });
    const onRetry = vi.fn();
    const onFork = vi.fn();
    renderStream({ showMessageActions: true, onRetry, onFork });

    expect(row().getAttribute("data-actions-state")).toBe("hidden");
    fireEvent.click(body());
    expect(row().getAttribute("data-actions-state")).toBe("revealed");
    fireEvent.click(body());
    expect(row().getAttribute("data-actions-state")).toBe("hidden");
    // Revealing is not pressing: the row's buttons stay untouched.
    expect(onRetry).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
  });

  it("the hidden action row is inert on a coarse pointer until it is revealed", () => {
    stubMedia({ coarse: true, phone: false });
    renderStream({ showMessageActions: true });

    expect(row().getAttribute("data-actions-state")).toBe("hidden");
    expect(row().getAttribute("data-actions-inert")).toBe("true");
    fireEvent.click(body());
    expect(row().getAttribute("data-actions-state")).toBe("revealed");
    expect(row().getAttribute("data-actions-inert")).toBeNull();
    // The reveal store is module-level and outlives this test; put it back so
    // the next case starts from a hidden row.
    fireEvent.click(body());
    expect(row().getAttribute("data-actions-state")).toBe("hidden");
  });

  it("a fine pointer keeps the body tap from pinning the actions open", () => {
    // Hover owns the row with a mouse; a click that pinned it open would be a
    // second behaviour for the same gesture (and the reason the tap gate is
    // width-or-coarse).
    stubMedia({ coarse: false, phone: false });
    renderStream({ showMessageActions: true });

    fireEvent.click(body());
    expect(row().getAttribute("data-actions-state")).toBe("hidden");
    expect(row().getAttribute("data-actions-inert")).toBeNull();
  });
});

describe("the selection bar", () => {
  const openBar = () =>
    fireEvent.click(screen.getByRole("button", { name: t("chat.message.shareTitle") }));

  it("its copy, download and cancel reach their callbacks and disable with an empty selection", async () => {
    renderStream();
    openBar();

    fireEvent.click(screen.getByRole("button", { name: t("chat.message.copyText") }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls.at(-1)?.[0])).toContain("the parser is fixed");

    fireEvent.click(screen.getByRole("button", { name: t("chat.message.downloadHTML") }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    // Unchecking the one message leaves the bar standing with nothing selected;
    // the two actions that would export nothing are the two that disable.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: t("chat.message.selectMessage", { role: t("chat.message.assistant") }),
      }),
    );
    expect(screen.getByText(t("chat.message.selected", { count: 0 }))).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: t("chat.message.copyText") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: t("chat.message.downloadHTML") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const cancel = screen.getByRole("button", {
      name: t("chat.message.cancel"),
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    fireEvent.click(cancel);
    expect(screen.queryByRole("region", { name: t("chat.message.selection") })).toBeNull();
  });
});

describe("the find bar's controls", () => {
  const prev = () => screen.getByRole("button", { name: t("chat.find.prev") }) as HTMLButtonElement;
  const next = () => screen.getByRole("button", { name: t("chat.find.next") }) as HTMLButtonElement;

  it("previous, next and close keep their accessible names and disabled state", () => {
    renderStream({ findSeed: "parser" });

    expect(prev().getAttribute("title")).toBe(t("chat.find.prev"));
    expect(next().getAttribute("title")).toBe(t("chat.find.next"));
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(false);

    fireEvent.change(screen.getByRole("textbox", { name: t("chat.find.label") }), {
      target: { value: "zzz" },
    });
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: t("chat.find.label") }), {
      target: { value: "parser" },
    });
    expect(prev().disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: t("chat.find.close") }));
    expect(screen.queryByRole("search")).toBeNull();
  });
});
