// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { setLocale, t } from "../../i18n";
import Composer from "./Composer";

/**
 * Text moved into the composer from outside it.
 *
 * Editing a queued message is the case: the page withdraws the message, writes
 * the text into the draft and bumps `focusSignal` so the person can fix it and
 * send it again. The composer has to show the new text — it reads `initialValue`
 * once per value, not once per mount — and the caret has to end up in it, or
 * the next keystroke goes somewhere else and the person hunts for the end of a
 * long message.
 */

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  return render(<Composer onSubmit={vi.fn()} {...props} />);
}

function box(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

beforeEach(() => {
  setLocale("en");
});

describe("Composer refill", () => {
  it("shows text that arrives after the first render", () => {
    // The draft lives outside the composer (localStorage, read by the page), so
    // the refill is a new `initialValue` on an already-mounted composer.
    const { rerender } = setup({ initialValue: "" });
    expect(box().value).toBe("");

    rerender(<Composer onSubmit={vi.fn()} initialValue="hold that thought" focusSignal={1} />);
    expect(box().value).toBe("hold that thought");
  });

  it("focuses the textarea and puts the caret at the end when asked", () => {
    const { rerender } = setup({ initialValue: "" });
    // Mounting is not a refill: nothing has been moved anywhere yet.
    expect(document.activeElement).not.toBe(box());

    rerender(<Composer onSubmit={vi.fn()} initialValue="hold that thought" focusSignal={1} />);
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe("hold that thought".length);
    expect(box().selectionEnd).toBe("hold that thought".length);
  });

  it("leaves an ordinary prefilled composer alone", () => {
    // A deep link fills the box on mount without a signal; taking the focus
    // there would pull the page to the composer the moment it opens.
    setup({ initialValue: "from a link" });
    expect(box().value).toBe("from a link");
    expect(document.activeElement).not.toBe(box());
  });

  it("draws the raised arrangement from the signal, before any focus lands", () => {
    // The conversation entered from Start mounts with the signal while its
    // detail — and the textarea — are still disabled, so no focus event can
    // arrive yet. The box must already be the shape the draft page left: a
    // compact first frame resizes the band the J3 hand-off sampler watches.
    const { container } = setup({ focusSignal: 1, disabled: true });
    expect(document.activeElement).not.toBe(box());
    expect(container.querySelector("[data-kin-composer-row]")?.className).toContain("mt-2");
    expect(box().className).toContain("min-h-11");
    expect(box().className).not.toContain("kin-composer-input");
  });

  it("keeps an empty, unfocused composer compact", () => {
    // The raised shape is the signal's doing, not a restyle of every composer.
    const { container } = setup();
    expect(container.querySelector("[data-kin-composer-row]")?.className).toContain("mt-1.5");
    expect(box().className).toContain("kin-composer-input");
  });
});

describe("the resting composer at a narrow card width", () => {
  function card(container: HTMLElement): HTMLElement {
    const surface = container.querySelector<HTMLElement>("[data-kin-composer-card]");
    if (!surface) throw new Error("the composer has no card surface");
    return surface;
  }

  it("a click on the composer card's padding puts the caret in the message box", () => {
    const { container } = setup();

    // A control keeps its own press: the card must not pull the caret away
    // from the thing the pointer actually hit.
    const attach = screen.getByRole("button", { name: t("composer.attachFile") });
    fireEvent.pointerDown(attach);
    expect(document.activeElement).not.toBe(box());

    // The card's own surface — its padding, the gap around the controls, the
    // bare corners — is the box as far as a pointer is concerned. The press is
    // default-prevented because the browser's own mousedown focus change runs
    // after this handler and would move the caret to the body; jsdom has no
    // such default action, so `false` (not prevented ⇒ `true`) is what pins it.
    expect(fireEvent.pointerDown(card(container))).toBe(false);
    expect(document.activeElement).toBe(box());
  });

  it("the resting composer is container-scoped, and the expanded arrangement stays a column", () => {
    // A structural assertion, not the width proof: the live measurement in the
    // PR body is what shows the textarea is wide enough at 768 and 820. This
    // only pins the mechanism, so a later `sm:` cannot quietly come back.
    const { container, rerender } = setup();
    expect(card(container).className).toContain("@container");

    const restingRow = box().parentElement!;
    expect(restingRow.className).toContain("@xl:flex-row");
    expect(restingRow.className).not.toContain("sm:flex-row");
    expect(box().className).toContain("@xl:flex-1");
    expect(box().className).toContain("min-h-11");
    expect(box().className).not.toContain("sm:flex-1");
    const controls = container.querySelector("[data-kin-composer-row]")!;
    expect(controls.className).toContain("@xl:mt-0");

    // The raised arrangement is a column at every width, before and after.
    rerender(<Composer onSubmit={vi.fn()} focusSignal={1} />);
    const expandedRow = box().parentElement!;
    expect(expandedRow.className).toContain("flex-col");
    expect(expandedRow.className).not.toContain("@xl:flex-row");
  });
});

describe("a send that fails while a refill lands", () => {
  /** A submit whose answer the test decides when to give. */
  function pendingSubmit() {
    let fail: (err: Error) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    return { onSubmit, fail: (err: Error) => fail(err) };
  }

  function submitText(text: string) {
    fireEvent.change(box(), { target: { value: text } });
    fireEvent.submit(box().closest("form")!);
  }

  it("restores the text when nothing else touched the composer", async () => {
    const { onSubmit, fail } = pendingSubmit();
    setup({ onSubmit });

    submitText("send me");
    expect(box().value).toBe("");

    await act(async () => fail(new Error("network down")));
    expect(box().value).toBe("send me");
  });

  it("keeps text that arrived while the send was failing", async () => {
    // The page can refill the composer from a queued message while a send is in
    // flight. A failed send's restore is for its own text, not for whatever is
    // there now — overwriting it would delete a message the person is holding.
    // The handler says so with `keepComposer`, which is a decision, not a guess
    // from the DOM: the refill's write reaches the textarea a render later.
    const { onSubmit, fail } = pendingSubmit();
    const { rerender } = setup({ onSubmit });

    submitText("send me");
    rerender(<Composer onSubmit={onSubmit} initialValue="hold that thought" focusSignal={1} />);
    expect(box().value).toBe("hold that thought");

    await act(async () => {
      fail(Object.assign(new Error("network down"), { keepComposer: true }));
    });
    expect(box().value).toBe("hold that thought");
  });
});

describe("focus after a send", () => {
  // The textarea is disabled while a send is in flight, and Chrome moves the
  // focus off a control the moment it becomes disabled — the 820×1180 walk
  // recorded it at t=1387 (disabled) → t=1449 (BODY). jsdom has no such
  // default action, and it refuses to blur a disabled control at all, so the
  // blur is performed while the box is still enabled. The state it leaves —
  // disabled textarea, focus on BODY — is exactly the one the walk recorded.
  async function flushAnimationFrame() {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }

  function submitDraft(text: string) {
    fireEvent.change(box(), { target: { value: text } });
    fireEvent.submit(box().closest("form")!);
  }

  it("returns focus to the textarea after a send that disabled it", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = setup({ onSubmit });

    box().focus();
    submitDraft("what changed?");
    expect(box().value).toBe("");

    box().blur();
    rerender(<Composer onSubmit={onSubmit} busy />);
    expect(box().disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);

    rerender(<Composer onSubmit={onSubmit} busy={false} />);
    await flushAnimationFrame();

    expect(document.activeElement).toBe(box());
  });

  it("does not take focus back when the reader moved it during the send", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = render(
      <>
        <Composer onSubmit={onSubmit} />
        <button>elsewhere</button>
      </>,
    );

    box().focus();
    submitDraft("what changed?");

    rerender(
      <>
        <Composer onSubmit={onSubmit} busy />
        <button>elsewhere</button>
      </>,
    );
    expect(box().disabled).toBe(true);
    const other = screen.getByRole("button", { name: "elsewhere" });
    other.focus();
    expect(document.activeElement).toBe(other);

    rerender(
      <>
        <Composer onSubmit={onSubmit} busy={false} />
        <button>elsewhere</button>
      </>,
    );
    await flushAnimationFrame();

    expect(document.activeElement).toBe(other);
  });

  it("returns focus after a send started from the send button", async () => {
    // A tap on the send button leaves the caret on a control inside the form,
    // not in the textarea. That is the path the 820 walk used, and it must owe
    // the caret back just like a hardware ⌘/Ctrl+Enter does.
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = setup({ onSubmit });

    fireEvent.change(box(), { target: { value: "sent from the button" } });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    send.focus();
    expect(document.activeElement).toBe(send);
    fireEvent.submit(box().closest("form")!);

    // Clearing the draft disables the send button, and Chrome blurs a control
    // it disables. jsdom refuses to blur a disabled control, so the node is
    // re-enabled for the one focus move; the next render sets it back.
    send.disabled = false;
    send.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(<Composer onSubmit={onSubmit} busy />);
    expect(box().disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);

    rerender(<Composer onSubmit={onSubmit} busy={false} />);
    await flushAnimationFrame();

    expect(document.activeElement).toBe(box());
  });

  it("leaves a composer the reader never focused unfocused", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = setup({ onSubmit });

    expect(document.activeElement).toBe(document.body);
    submitDraft("sent without touching the box");

    rerender(<Composer onSubmit={onSubmit} busy />);
    expect(box().disabled).toBe(true);

    rerender(<Composer onSubmit={onSubmit} busy={false} />);
    await flushAnimationFrame();

    expect(document.activeElement).toBe(document.body);
  });
});
