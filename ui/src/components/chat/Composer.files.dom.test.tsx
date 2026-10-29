// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import type { AgentInfo } from "../../api/client";
import Composer from "./Composer";

/**
 * The composer's @ menu, with a workspace behind it.
 *
 * The file section is a question asked of the task's workspace — which, for a
 * task started from the phone, is a checkout on another machine. So the tests
 * here are about the conversation with that question: when it is asked, which
 * answer is allowed to land, and what the menu does when there is no answer.
 */

function agent(id: string): AgentInfo {
  return {
    id,
    name: id,
    installed: true,
    available: true,
    default: false,
    model_list_source: "none",
    model_list_status: "unavailable",
  };
}

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<Composer onSubmit={onSubmit} {...props} />);
  return { onSubmit, box: screen.getByRole("textbox") };
}

beforeEach(() => {
  setLocale("en");
});

describe("Composer file mentions", () => {
  it("asks the workspace once typing settles, and inserts the path", async () => {
    const user = userEvent.setup();
    const fileSearch = vi.fn(async () => ["src/readme.md"]);
    const { onSubmit, box } = setup({ fileSearch });

    await user.type(box, "@rea");
    await waitFor(() => expect(fileSearch).toHaveBeenCalledWith("rea"));

    const option = await screen.findByRole("option", { name: /src\/readme\.md/ });
    expect(screen.getByText("files")).toBeTruthy();

    await user.click(option);
    expect((box as HTMLTextAreaElement).value).toBe("@src/readme.md ");
    // Picking from the menu is not sending.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps agents first and files after them in one list", async () => {
    const user = userEvent.setup();
    const fileSearch = vi.fn(async () => ["config/app.ts"]);
    const { box } = setup({ agents: [agent("codex")], fileSearch });

    await user.type(box, "@co");
    await screen.findByRole("option", { name: /config\/app\.ts/ });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("@codex");
    expect(options[1].textContent).toContain("config/app.ts");
  });

  it("shows no file section when the workspace cannot answer", async () => {
    const user = userEvent.setup();
    // A task with no checkout, or a machine that is away: the route refuses.
    const fileSearch = vi.fn(async () => {
      throw new Error("not a checkout");
    });
    const { box } = setup({ agents: [agent("codex")], fileSearch });

    await user.type(box, "@co");
    await waitFor(() => expect(fileSearch).toHaveBeenCalledWith("co"));

    // The agent row is still there; the file heading is not, and neither is a
    // section pretending the workspace has no such file.
    expect(await screen.findByRole("option", { name: /@codex/ })).toBeTruthy();
    expect(screen.queryByText("files")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    // The search is over, failure and all: no spinner left running over a
    // question nobody is going to answer.
    expect(screen.queryByText("Searching files…")).toBeNull();
    // And the title does not promise a section that is not there.
    expect(screen.getByText("@ agents · workers only run tasks")).toBeTruthy();
  });

  // Both agents match both queries, so the list keeps its length and only a
  // deliberate reset moves the highlight off the row it was on.
  it("puts the highlight back on the first row when the query changes", async () => {
    const user = userEvent.setup();
    const { box } = setup({ agents: [agent("ab"), agent("ba")] });

    await user.type(box, "@");
    expect(await screen.findByRole("option", { name: /@ba/ })).toBeTruthy();
    await user.keyboard("{ArrowDown}");

    await user.type(box, "a");
    await user.keyboard("{Enter}");
    expect((box as HTMLTextAreaElement).value).toBe("@ab ");
  });

  it("starts a new query at its best row", async () => {
    const user = userEvent.setup();
    const fileSearch = vi.fn(async (query: string) => [`${query}-one.md`, `${query}-two.md`]);
    const { box } = setup({ fileSearch });

    await user.type(box, "@a");
    await screen.findByRole("option", { name: /a-two\.md/ });
    await user.keyboard("{ArrowDown}");

    await user.type(box, "b");
    await screen.findByRole("option", { name: /ab-two\.md/ });
    await user.keyboard("{Enter}");
    expect((box as HTMLTextAreaElement).value).toBe("@ab-one.md ");
  });

  it("drops an answer to a query the caret has moved past", async () => {
    const user = userEvent.setup();
    let answerFirst: (files: string[]) => void = () => {};
    const fileSearch = vi.fn((query: string) => {
      if (query === "aa") {
        return new Promise<string[]>((resolve) => {
          answerFirst = resolve;
        });
      }
      return Promise.resolve(["second.md"]);
    });
    const { box } = setup({ fileSearch });

    await user.type(box, "@aa");
    await waitFor(() => expect(fileSearch).toHaveBeenCalledWith("aa"));

    await user.type(box, "b");
    await waitFor(() => expect(fileSearch).toHaveBeenCalledWith("aab"));
    expect(await screen.findByRole("option", { name: /second\.md/ })).toBeTruthy();

    // The first question is answered last. It is about a different query, so
    // the menu keeps the answer the caret is actually asking about.
    answerFirst(["first.md"]);
    await waitFor(() => expect(screen.queryByText("first.md")).toBeNull());
    expect(screen.getByRole("option", { name: /second\.md/ })).toBeTruthy();
  });

  // The menu must not eat Enter. A sentence-ending `@claude.` is prose; it is
  // not a half-typed mention, and a file named CLAUDE.md matches its text.
  it("closes on a sentence stop so Enter sends the message", async () => {
    const user = userEvent.setup();
    const fileSearch = vi.fn(async () => ["CLAUDE.md"]);
    const { onSubmit, box } = setup({ fileSearch });

    await user.type(box, "ask @claude.");
    // Long enough for the debounce to have fired, had the menu stayed open.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole("option")).toBeNull();

    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("ask @claude.", undefined);
  });

  it("searches for a path typed in another script", async () => {
    const user = userEvent.setup();
    const fileSearch = vi.fn(async () => ["文档/说明.md"]);
    const { box } = setup({ fileSearch });

    await user.type(box, "@文档/说明");
    await waitFor(() => expect(fileSearch).toHaveBeenCalledWith("文档/说明"));
    expect(await screen.findByRole("option", { name: /文档\/说明\.md/ })).toBeTruthy();
  });

  it("drops the rows of a query the person has typed past", async () => {
    const user = userEvent.setup();
    const fileSearch = vi.fn((query: string) => {
      if (query === "rea") return Promise.resolve(["readme.md"]);
      // The longer query is answered by nobody, so the only rows on screen
      // would be the ones from the shorter one.
      return new Promise<string[]>(() => {});
    });
    const { box } = setup({ fileSearch });

    await user.type(box, "@rea");
    expect(await screen.findByRole("option", { name: /readme\.md/ })).toBeTruthy();

    await user.type(box, "x");
    await waitFor(() => expect(screen.queryByText("readme.md")).toBeNull());
    expect(screen.getByText("Searching files…")).toBeTruthy();
  });

  it("keeps the chosen row in view", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const fileSearch = vi.fn(async () => ["a/really/long/path/file.md"]);
      const { box } = setup({ fileSearch });

      await user.type(box, "@file");
      await screen.findByRole("option", { name: /file\.md/ });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("offers agents alone when the page has no workspace to search", async () => {
    const user = userEvent.setup();
    const { box } = setup({ agents: [agent("codex")] });

    await user.type(box, "@co");
    expect(await screen.findByRole("option", { name: /@codex/ })).toBeTruthy();
    expect(screen.queryByText("files")).toBeNull();
    // The agent-only menu keeps the delegation wording.
    expect(screen.getByText("@ agents · workers only run tasks")).toBeTruthy();
  });
});
