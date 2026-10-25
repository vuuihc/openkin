// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "./Sidebar";
import type { AgentInfo } from "../../api/client";
import { setLocale } from "../../i18n";

/**
 * The sidebar's import menu is one of the four surfaces that start an import,
 * and it is the one a person reaches first. Two things about it are decided in
 * the component and nowhere else: whether the menu items can be pressed at all
 * while an import is already running, and what pressing one asks for — the
 * provider that was pressed, not "everything".
 *
 * Neither is visible to the logic tests: `importTargetsFor` can be perfect
 * while the menu hands it the wrong list, and the hook can share one busy flag
 * while the menu ignores it.
 */

// The machine list the sidebar reads is a network call, and the panel is drawn
// whether or not it answers. It is stubbed empty rather than left to fail.
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
  };
});

// The console's default locale is Chinese, and the assertions below are about
// labels. Saying which locale the test means is the difference between testing
// a string and testing whichever language the machine running it happens to be
// set to.
beforeEach(() => {
  setLocale("en");
});

function provider(id: string, name: string, capabilities: string[] = ["session_list"]): AgentInfo {
  return { id, name, capabilities } as AgentInfo;
}

type SidebarProps = {
  importing?: boolean;
  onImport?: (agents?: string[]) => void;
  catalog?: AgentInfo[];
};

function sidebar(props: SidebarProps) {
  return (
    <MemoryRouter>
      <Sidebar
        tasks={[]}
        pendingCount={0}
        // The panel is drawn twice — once for the desktop rail and once inside
        // the mobile drawer — and both copies carry this menu. Closing the
        // drawer is what leaves one of it in the document; the markup under
        // test is the same element either way.
        mobileOpen={false}
        onCloseMobile={() => {}}
        onNewChat={() => {}}
        agentCatalog={props.catalog ?? [provider("codex", "Codex")]}
        importingExternalSessions={props.importing ?? false}
        onImportExternalSessions={props.onImport ?? vi.fn()}
      />
    </MemoryRouter>
  );
}

function importTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /import agent sessions/i });
}

/**
 * The control's own disabled state, read off the element.
 *
 * Not `jest-dom`'s matcher, which would be a fifth dependency for one word: a
 * button here is either disabled or it is not, and there is no fieldset in
 * between to inherit it from. Only saying "disabled" is not enough on its own
 * anyway — the click below is what proves the press does nothing.
 */
function expectDisabled(el: HTMLElement): void {
  expect((el as HTMLButtonElement).disabled, `"${el.textContent}" should be disabled`).toBe(true);
}

describe("the sidebar's import menu", () => {
  it("asks for the provider that was pressed, not for every provider", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(
      sidebar({
        onImport,
        catalog: [provider("codex", "Codex"), provider("claude-code", "Claude Code")],
      }),
    );

    await user.click(importTrigger());
    await user.click(screen.getByRole("menuitem", { name: /claude code/i }));

    // The id, not the name: what travels to the Hub is the provider id, and the
    // two are different strings that a person never sees apart.
    expect(onImport).toHaveBeenCalledWith(["claude-code"]);
  });

  it("asks for everything when the all-providers item is pressed", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(sidebar({ onImport }));

    await user.click(importTrigger());
    await user.click(screen.getByRole("menuitem", { name: /import all available agents/i }));

    // No argument is how this menu says "every provider on every machine": an
    // empty array would mean "the ones you can see here", which is a different
    // errand with a different answer.
    expect(onImport).toHaveBeenCalledWith();
  });

  it("cannot be pressed twice: the items are disabled while an import runs", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    const { rerender } = render(sidebar({ onImport }));

    // The menu is open when the import starts, which is not a contrived
    // ordering: the automatic sync runs on a 30 second timer and does not ask
    // whether a menu happens to be open.
    await user.click(importTrigger());
    rerender(sidebar({ onImport, importing: true }));

    expectDisabled(screen.getByRole("menuitem", { name: /codex/i }));
    expectDisabled(screen.getByRole("menuitem", { name: /import all available agents/i }));
    // And the trigger itself says what is happening rather than reading as
    // ready: its label is the only progress this control has.
    expectDisabled(screen.getByRole("button", { name: /importing agent sessions/i }));

    await user.click(screen.getByRole("menuitem", { name: /codex/i }));
    expect(onImport).not.toHaveBeenCalled();
  });

  it("offers only the providers that say they can list sessions", async () => {
    const user = userEvent.setup();
    render(
      sidebar({
        catalog: [
          provider("codex", "Codex"),
          // A provider can run tasks and still have no session list to import.
          // Offering it would be a row whose answer is always empty, which
          // reads as "you have no sessions" rather than "this one cannot say".
          provider("grok", "Grok", []),
        ],
      }),
    );

    await user.click(importTrigger());

    expect(screen.getByRole("menuitem", { name: /codex/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /grok/i })).toBeNull();
  });

  it("says no provider can list sessions rather than showing an empty menu", async () => {
    const user = userEvent.setup();
    render(sidebar({ catalog: [provider("grok", "Grok", [])] }));

    await user.click(importTrigger());

    // The menu still opens and still has the all-providers item; what it must
    // not do is look like a menu of one. Asserting the sentence rather than a
    // count of items is deliberate: the sentence is the behaviour, and a count
    // would be a second way of saying what the test above already says.
    expect(screen.getByText("No local Agent session providers detected")).toBeTruthy();
  });
});
