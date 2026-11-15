// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { setLocale, t } from "../i18n";
import { resetLeaveGuard, setLeaveGuard } from "../lib/leaveGuard";
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

/** A path readout plus a Back button, so a hop's history depth is observable. */
function Probe({ onNewChat = vi.fn() }: { onNewChat?: () => void } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <button type="button" onClick={() => navigate(-1)}>
        back
      </button>
      <CommandPalette
        open
        onClose={vi.fn()}
        onNewChat={onNewChat}
        onTogglePanel={vi.fn()}
        panelCtx={{ taskId: null, remote: false, desktop: false }}
      />
    </>
  );
}

function renderProbe() {
  return render(
    <MemoryRouter initialEntries={["/sessions", "/routines"]}>
      <Probe />
    </MemoryRouter>,
  );
}

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

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
  resetLeaveGuard();
  vi.unstubAllGlobals();
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

  it("replaces a destination with the next one on a phone, so Back returns to the list", () => {
    // KIN-CONTINUE-002, R5: hopping Routines -> Settings from the palette must
    // not nest two destinations. Back goes to the list, not to Routines.
    viewport(false);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("path").textContent).toBe("/settings");

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByTestId("path").textContent).toBe("/sessions");
  });

  it("keeps ordinary browser history on a Mac", () => {
    viewport(true);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("path").textContent).toBe("/settings");

    fireEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByTestId("path").textContent).toBe("/routines");
  });

  it("does not leave a page that refuses to be left", () => {
    viewport(false);
    setLeaveGuard(() => false);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("path").textContent).toBe("/routines");
  });

  it("asks the page before the New chat row navigates", () => {
    // `onNewChat` navigates on its own, so the guard has to run before the row
    // does anything, not inside the place navigation afterwards.
    viewport(false);
    setLeaveGuard(() => false);
    const onNewChat = vi.fn();
    render(
      <MemoryRouter initialEntries={["/routines"]}>
        <Probe onNewChat={onNewChat} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    expect(onNewChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("path").textContent).toBe("/routines");
  });

  it("asks the page once, not twice, when the reader agrees", () => {
    // The row asks before it closes the palette; the navigation it then calls
    // asks its own guard too. A page guarding with `window.confirm` would show
    // the same dialog a second time (KIN-CONTINUE-002 review, nit).
    viewport(false);
    const canLeave = vi.fn(() => true);
    setLeaveGuard(canLeave);
    renderProbe();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(canLeave).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("path").textContent).toBe("/settings");
  });

  it("asks the page once before the New chat row navigates", () => {
    viewport(false);
    const canLeave = vi.fn(() => true);
    setLeaveGuard(canLeave);
    const onNewChat = vi.fn();
    render(
      <MemoryRouter initialEntries={["/routines"]}>
        <Probe onNewChat={onNewChat} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    expect(canLeave).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledWith(true);
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
