// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import Composer from "./Composer";

/**
 * The composer's send keys.
 *
 * Enter is a newline on every keyboard, including a phone's software keyboard
 * — which has no Shift, so a "Shift+Enter for a newline" rule would leave a
 * phone unable to write a second line and send half a sentence on the first
 * pause. Sending is the send button, or ⌘/Ctrl+Enter on a hardware keyboard;
 * the `⌘↵` legend beside the composer is that second path, named.
 */

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<Composer onSubmit={onSubmit} {...props} />);
  return { onSubmit, box: screen.getByRole("textbox") as HTMLTextAreaElement };
}

beforeEach(() => {
  setLocale("en");
});

describe("Composer send keys", () => {
  it("writes a newline on Enter and does not send", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup();

    await user.type(box, "first line{Enter}second line");

    expect(box.value).toBe("first line\nsecond line");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps Shift+Enter a newline", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup();

    await user.type(box, "one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(box, "two");

    expect(box.value).toBe("one\ntwo");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends on ⌘Enter", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup();

    await user.type(box, "ship it");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSubmit).toHaveBeenCalledWith("ship it", undefined);
  });

  it("sends on Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup();

    await user.type(box, "ship it");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onSubmit).toHaveBeenCalledWith("ship it", undefined);
  });

  it("still sends from the send button", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup();

    await user.type(box, "ship it");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("ship it", undefined);
  });
});
