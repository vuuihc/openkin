// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setLocale, t } from "../i18n";
import CommandPalette from "./CommandPalette";

/**
 * KIN-CONTINUE-001, step 2: the palette is commands, not a third list.
 *
 * It used to append the newest chats and a transcript search under the
 * actions — a second and third place to type the same word that the sidebar's
 * search already answers, and one of them asked the daemon on every pause.
 * Whatever a person types here now filters actions and places only.
 *
 * KIN-CONTINUE-001.
 */

const listTasks = vi.fn();
const searchTranscript = vi.fn();
const listProjects = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    isAuthenticated: () => true,
    listTasks: (...args: unknown[]) => listTasks(...args),
    listProjects: (...args: unknown[]) => listProjects(...args),
    searchTranscript: (...args: unknown[]) => searchTranscript(...args),
  };
});

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <CommandPalette
        open
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        onTogglePanel={vi.fn()}
        panelCtx={{ taskId: null, remote: false, desktop: false }}
      />
    </MemoryRouter>,
  );
}

const searchBox = () => screen.getByPlaceholderText(t("palette.search"));

beforeEach(() => {
  setLocale("en");
  listTasks.mockReset().mockResolvedValue([]);
  listProjects.mockReset().mockResolvedValue([]);
  searchTranscript.mockReset().mockResolvedValue({ matches: [], truncated: false });
});

describe("the command palette", () => {
  it("lists actions only — no chats and no messages section", () => {
    renderPalette();

    expect(screen.getByText(t("palette.actions"))).toBeTruthy();
    // Literal headings, not `t("palette.chats")`: that key is gone, so the
    // translation helper would return the key path and the assertion could
    // never fail. "Chats" is also the name of the destination action, so the
    // count is what says no section came back with it.
    expect(screen.getAllByText("Chats")).toHaveLength(1);
    expect(screen.queryByText("Messages")).toBeNull();
    expect(screen.queryAllByRole("button")).not.toHaveLength(0);
  });

  it("never asks the daemon for conversations or transcript text", async () => {
    renderPalette();
    fireEvent.change(searchBox(), { target: { value: "release token" } });

    // Longer than the old 250ms message debounce: if the search came back, it
    // would have fired by now.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 400));
    });

    expect(listTasks).not.toHaveBeenCalled();
    expect(searchTranscript).not.toHaveBeenCalled();
  });
});
