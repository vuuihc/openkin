// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { setLocale } from "../../i18n";
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
