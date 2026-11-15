// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import type { AgentRole } from "../../lib/agentRoles";
import Composer from "./Composer";

/**
 * The composer's `/` menu: the saved roles, one keystroke away.
 *
 * A role's text is written into the draft, never sent on its own, because the
 * draft is what the transcript shows. So the tests here are about the menu as
 * a picker — it opens on a slash token, narrows as the token grows, and Enter
 * picks rather than sends. The one thing it must not do is trap the slash:
 * when there is nothing to pick, Enter is the plain newline it is everywhere
 * else in the composer (sending is ⌘/Ctrl+Enter or the send button).
 */

const review: AgentRole = {
  id: "review",
  name: "Review",
  prompt: "Review as a security engineer.",
};
const commit: AgentRole = {
  id: "commit",
  name: "Commit",
  prompt: "Write the message in the imperative.",
};

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<Composer onSubmit={onSubmit} {...props} />);
  return { onSubmit, box: screen.getByRole("textbox") as HTMLTextAreaElement };
}

beforeEach(() => {
  setLocale("en");
});

describe("Composer prompt shortcuts", () => {
  it("lists the saved roles on `/` and writes one into the draft on click", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { onSubmit, box } = setup({ roles: [review, commit], onValueChange });

    await user.type(box, "/");
    expect(screen.getByRole("listbox", { name: "Prompt shortcuts" })).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("Review");
    expect(options[1].textContent).toContain("Commit");
    // The prompt's first line is the second line of the row: a name alone says
    // nothing about what the pick will write.
    expect(screen.getByText("Review as a security engineer.")).toBeTruthy();
    expect(screen.getByText(/edit it before sending/)).toBeTruthy();

    await user.click(screen.getByRole("option", { name: /Review/ }));
    expect(box.value).toBe("Review as a security engineer.");
    expect(onValueChange).toHaveBeenLastCalledWith("Review as a security engineer.");
    expect(onSubmit).not.toHaveBeenCalled();
    // Picking settles the menu; the draft is the role's text and nothing else.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("narrows by name as the token grows", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/comm");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Commit");
  });

  it("narrows by the prompt's own words, not only the name", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/security");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Review");
  });

  it("picks on Enter instead of sending the token", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review, commit] });

    await user.type(box, "/rev");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("Review as a security engineer.");
    // Sending "/rev" to the agent was never what the menu looked like it would
    // do; Enter belongs to the highlighted row while one is on screen.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("moves the highlight with the arrow keys and picks that row", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{Enter}");
    expect(box.value).toBe("Write the message in the imperative.");
  });

  it("wraps the highlight around the ends of the list", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/");
    await user.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    // Down from the last row also wraps, back to the first.
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("picks the highlighted row on Tab", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Tab}");
    expect(box.value).toBe("Write the message in the imperative.");
  });

  it("starts the highlight over when the query changes", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/");
    await user.keyboard("{ArrowDown}");
    // "e" still matches both roles, so the list did not change — only the
    // question did, and the highlight belongs to the new question.
    await user.type(box, "e");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("Review as a security engineer.");
  });

  it("clamps the highlight when the list shrinks under it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} roles={[review, commit]} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(box, "/");
    await user.keyboard("{ArrowDown}");
    // A save on the settings route replaces the list while the menu stays open
    // — the query did not change, so only the clamp can move the highlight.
    rerender(<Composer onSubmit={onSubmit} roles={[review]} />);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    // One row left, and it has to be the selected one: a highlight pointing
    // past the end of the list reads as "nothing is chosen".
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(box.value).toBe("Review as a security engineer.");
  });

  it("keeps the token on Escape, and Enter writes a newline instead of sending it", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review, commit] });

    await user.type(box, "/rev");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.value).toBe("/rev");

    // Escape declined the menu, not the message. Enter is no longer a send on
    // any keyboard — a phone has no Shift to make it a newline — so the
    // declined token stays in the draft and a second line opens under it.
    await user.keyboard("{Enter}");
    expect(box.value).toBe("/rev\n");
    expect(onSubmit).not.toHaveBeenCalled();

    // Sending is the explicit shortcut the legend names.
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledWith("/rev", undefined);
  });

  it("closes on a space, because that is prose", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review, commit] });

    await user.type(box, "/rev ");
    // "/usr/bin" is a path and "or /rev" is a sentence; a token with a space in
    // it is no longer asking to be completed.
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.keyboard("{Enter}");
    expect(box.value).toBe("/rev \n");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledWith("/rev", undefined);
  });

  it("says there are no roles yet, and leaves the slash to the draft", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup();

    await user.type(box, "/");
    expect(
      screen.getByText("No saved roles yet. Add one in Settings → Agents → Roles."),
    ).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // Nothing to pick, so no explanation of what a pick would do.
    expect(screen.queryByText(/edit it before sending/)).toBeNull();

    // The menu has nothing to pick, so it must not own Enter. A composer that
    // swallowed the slash would be a dead key for every daemon with no roles.
    await user.keyboard("{Enter}");
    expect(box.value).toBe("/\n");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledWith("/", undefined);
  });

  it("does not claim there are no roles before the list is known", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: null });

    await user.type(box, "/");
    // An unreachable or still-answering daemon has not said the list is empty.
    // "No saved roles yet" would send someone to re-add roles it still has.
    expect(screen.getByText("Saved roles are unavailable right now.")).toBeTruthy();
    expect(screen.queryByText(/No saved roles yet/)).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    await user.keyboard("{Enter}");
    expect(box.value).toBe("/\n");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledWith("/", undefined);
  });

  it("says so when nothing matches, and leaves the token in the draft", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review, commit] });

    await user.type(box, "/zzz");
    expect(screen.getByText("No role matches that.")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // No rows, no legend: there is nothing to move through or select.
    expect(screen.queryByText("↑↓ navigate · ↵ select")).toBeNull();
    expect(screen.queryByText(/edit it before sending/)).toBeNull();

    await user.keyboard("{Enter}");
    expect(box.value).toBe("/zzz\n");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledWith("/zzz", undefined);
  });

  it("offers the keyboard legend only when there are rows to move through", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review] });
    await user.type(box, "/");
    expect(screen.getByText("↑↓ navigate · ↵ select")).toBeTruthy();
  });

  it("previews the first non-empty line of a multi-line prompt", async () => {
    const user = userEvent.setup();
    const spaced: AgentRole = {
      id: "spaced",
      name: "Spaced",
      prompt: "\n\nLead with the conclusion.\nThen the detail.",
    };
    const { box } = setup({ roles: [spaced] });

    await user.type(box, "/");
    expect(screen.getByText("Lead with the conclusion.")).toBeTruthy();
  });

  it("leaves Enter to the IME while it is composing", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review] });

    await user.type(box, "/rev");
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });

    // That Enter confirms a candidate in the composition editor. Picking the
    // row would replace the text the person is still writing, and sending it
    // would send half a sentence.
    expect(box.value).toBe("/rev");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("does not send the picked prompt when Enter is held down", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review] });

    await user.type(box, "/rev");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("Review as a security engineer.");

    // Auto-repeat: the menu is gone, but the key has not been released. The
    // repeat must not send the prompt the first keydown just wrote — the copy
    // says the draft is there to edit before sending.
    fireEvent.keyDown(box, { key: "Enter", repeat: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not take a modified Enter as a pick", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review] });

    await user.type(box, "/rev");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    // Shift+Enter is a newline. Picking here would overwrite the token the
    // person chose to keep typing after.
    expect(box.value).toBe("/rev\n");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("returns the caret to the draft after a pick", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review] });

    await user.type(box, "/rev");
    await user.click(screen.getByRole("option", { name: /Review/ }));
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("does not reopen the menu when the picked prompt is itself a token", async () => {
    const user = userEvent.setup();
    const compact: AgentRole = { id: "compact", name: "Compact", prompt: "/compact" };
    const { box } = setup({ roles: [compact] });

    await user.type(box, "/");
    await user.keyboard("{Enter}");
    // The pick happened on keydown; the keyup must not read the fresh draft
    // and take "/compact" for a new slash token.
    expect(box.value).toBe("/compact");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps Escape's dismissal when the caret moves, and drops it on typing", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/rev");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Moving the caret re-reads the draft, but the value is the one Escape
    // declined, so the menu stays away.
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("{ArrowRight}");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Typing is a new question. "i" keeps the token matching Review, so the
    // open menu has a row to show.
    await user.type(box, "i");
    expect(box.value).toBe("/revi");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("forgets Escape's dismissal once the message is sent", async () => {
    const user = userEvent.setup();
    const { onSubmit, box } = setup({ roles: [review, commit] });

    await user.type(box, "/rev");
    await user.keyboard("{Escape}");
    // Sent from the send control, not Enter: no keyup follows to re-read the
    // emptied draft, so only the submit path itself can clear the dismissal.
    fireEvent.submit(box.closest("form")!);
    expect(onSubmit).toHaveBeenCalledWith("/rev", undefined);

    // Pasted, so the empty box becomes this exact token in one change — the
    // one Escape declined a moment ago. Sending was the new question.
    await user.paste("/rev");
    expect(box.value).toBe("/rev");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("forgets Escape's dismissal when the draft is emptied", async () => {
    const user = userEvent.setup();
    const { box } = setup({ roles: [review, commit] });

    await user.type(box, "/rev");
    await user.keyboard("{Escape}");
    await user.clear(box);
    expect(box.value).toBe("");

    // A token pasted into an empty box is a fresh draft — not the one Escape
    // declined, even when it is the same text character for character.
    await user.paste("/rev");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("closes the menu when the draft is replaced from outside", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} roles={[review]} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(box, "/rev");
    expect(screen.getByRole("listbox")).toBeTruthy();

    // The new-chat page's role row replaces the draft exactly like this. A menu
    // still pointing at "/rev" would pick into text it never saw.
    rerender(
      <Composer
        onSubmit={onSubmit}
        roles={[review]}
        initialValue={"Review as a security engineer."}
      />,
    );
    expect(box.value).toBe("Review as a security engineer.");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledWith("Review as a security engineer.", undefined);
  });

  it("closes the menu when the replacement is a different token", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} roles={[review]} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(box, "/rev");
    expect(screen.getByRole("listbox")).toBeTruthy();

    // Same shape, different query: the rows were filtered for "rev", and a
    // pick would replace text the menu never saw.
    rerender(<Composer onSubmit={onSubmit} roles={[review]} initialValue="/com" />);
    expect(box.value).toBe("/com");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the menu open when the draft is echoed back unchanged", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer onSubmit={onSubmit} roles={[review]} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;

    await user.type(box, "/rev");
    // The task page re-reads its saved draft and hands the same text back on
    // every render. That echo is not a replacement, and closing the menu on it
    // would make the menu unusable there.
    rerender(<Composer onSubmit={onSubmit} roles={[review]} initialValue="/rev" />);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
