// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Textarea from "./Textarea";

/**
 * The shared multi-line field.
 *
 * It is a textarea, so Enter is the user's newline and must not be stolen; the
 * send-style action belongs to Shift+Enter. The IME guard is the console's
 * shared one: a composing Shift+Enter is still a half-typed word, not a
 * finished message.
 */

const noop = vi.fn();

function describedText(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("the shared textarea", () => {
  it("renders a labelled textarea with the requested rows and hint", () => {
    render(<Textarea label="Notes" hint="Markdown is fine." rows={6} value="" onChange={noop} />);

    const box = screen.getByRole("textbox", { name: /Notes/ });
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("rows")).toBe("6");
    expect(describedText(box)).toContain("Markdown is fine.");
  });

  it("Shift+Enter calls onEnter; Enter and an IME composition do not", () => {
    const onEnter = vi.fn();
    render(<Textarea label="Message" value="" onChange={noop} onEnter={onEnter} />);

    const box = screen.getByRole("textbox", { name: /Message/ });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onEnter).toHaveBeenCalledTimes(1);

    // A composing Shift+Enter must not send: the standard flag first, then the
    // 229 sentinel some IMEs send before `isComposing` flips.
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true, isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true, keyCode: 229 });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("an error is described by the textarea", () => {
    render(
      <Textarea
        label="Message"
        hint="Keep it short."
        error="Write at least one sentence."
        value=""
        onChange={noop}
      />,
    );

    const box = screen.getByRole("textbox", { name: /Message/ });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(box)).toContain("Write at least one sentence.");
  });
});
