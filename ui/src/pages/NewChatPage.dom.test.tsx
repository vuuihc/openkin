// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { AgentInfo, MachineInfo, Task } from "../api/client";
import { ApiError } from "../api/client";
import { setLocale } from "../i18n";
import { resetMachinesCache } from "../hooks/useMachines";
import { useAppStore } from "../store/appStore";

/**
 * KIN-START-001: the draft is one card and one place.
 *
 * The greeting, the card that writes the run, and the place row under it are
 * the whole screen. Start is blocked — visibly, with a reason — when there is
 * no agent, no place, nowhere online to run, or no connection; the draft itself
 * is never cleared by any of those states.
 */

const client = vi.hoisted(() => ({
  serverVersion: vi.fn(),
  listMachines: vi.fn(),
  listAgents: vi.fn(),
  recentCwds: vi.fn(),
  getRoutingOptions: vi.fn(),
  getSettings: vi.fn(),
  findProjectByRoot: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    serverVersion: client.serverVersion,
    listMachines: client.listMachines,
    listAgents: client.listAgents,
    recentCwds: client.recentCwds,
    getRoutingOptions: client.getRoutingOptions,
    getSettings: client.getSettings,
    findProjectByRoot: client.findProjectByRoot,
    createTask: client.createTask,
  };
});

import NewChatPage from "./NewChatPage";

const AGENT: AgentInfo = {
  id: "claude-code",
  name: "Claude Code",
  kind: "native",
  installed: true,
  available: true,
  default: true,
  models: [
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
  ],
  model_list_source: "recommended",
  model_list_status: "available",
  permission_modes: ["default", "accept_edits", "yolo"],
};

const STUDIO: MachineInfo = {
  id: "device-studio",
  label: "Studio",
  reachability: "offline",
  agents: [],
  workspace_roots: ["/srv/gamma"],
};

const STUDIO_LIVE: MachineInfo = {
  id: "device-studio",
  label: "Studio",
  reachability: "online",
  agents: [
    {
      id: "claude-code",
      installed: true,
      available: true,
      is_default: true,
      models: ["sonnet", "opus"],
      permission_modes: ["default", "accept_edits"],
    },
  ],
  workspace_roots: ["/srv/gamma"],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewChatPage />} />
        <Route path="/tasks/:id" element={<div>conversation</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderDraftRootNavigation() {
  function LocationState() {
    return <output aria-label="entry state">{JSON.stringify(useLocation().state)}</output>;
  }
  window.history.replaceState({ idx: 0 }, "", "/new");
  return render(
    <BrowserRouter>
      <Routes>
        <Route
          path="/new"
          element={
            <>
              <NewChatPage />
              <LocationState />
            </>
          }
        />
        <Route
          path="/agents"
          element={
            <>
              <div>agent management</div>
              <LocationState />
            </>
          }
        />
      </Routes>
    </BrowserRouter>,
  );
}

function setWideScreen(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query.includes("min-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function startButton() {
  return screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
}

function promptBox() {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function placeRow() {
  return screen.getByRole("button", { name: /^Device & project/ });
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  resetMachinesCache();
  setWideScreen(true);
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0, toasts: [] });
  for (const fn of Object.values(client)) fn.mockReset();
  client.serverVersion.mockResolvedValue({ desktop_id: "desktop-self", desktop_name: "This Mac" });
  client.listMachines.mockResolvedValue([]);
  client.listAgents.mockResolvedValue([AGENT]);
  client.recentCwds.mockResolvedValue(["/work/alpha", "/work/beta"]);
  client.getRoutingOptions.mockResolvedValue({ defaults: { enabled: false } });
  client.getSettings.mockResolvedValue({});
  client.findProjectByRoot.mockRejectedValue(new ApiError(404, "not found"));
  client.createTask.mockResolvedValue({
    id: "task-1",
    title: "tidy",
    agent: "claude-code",
    cwd: "/work/alpha",
    prompt: "tidy the notes",
    status: "queued",
    created_at: Date.now(),
  } as Task);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetMachinesCache();
});

describe("the draft (KIN-START-001)", () => {
  it("opens on one card with the place row under it", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "What should Kin do?" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(1);
    expect(
      await screen.findByRole("button", { name: "Device & project: This machine · alpha" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Run settings/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Run settings/ }).textContent).toContain("Default");
  });

  it("keeps Start disabled on an empty prompt and enables it when there is text", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Device & project: This machine · alpha" });
    expect(startButton().disabled).toBe(true);

    await user.type(promptBox(), "tidy the notes");
    expect(startButton().disabled).toBe(false);
  });

  it("starts with the chosen place, prompt and run settings", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Device & project: This machine · alpha" });
    await user.type(promptBox(), "tidy the notes");
    await user.click(startButton());

    await waitFor(() => expect(client.createTask).toHaveBeenCalledTimes(1));
    const body = client.createTask.mock.calls[0][0] as Record<string, unknown>;
    expect(body.agent).toBe("claude-code");
    expect(body.cwd).toBe("/work/alpha");
    expect(body.prompt).toBe("tidy the notes");
    expect(body.permission_mode).toBe("default");
    expect(await screen.findByText("conversation")).toBeTruthy();
  });

  it("blocks Start and says why when no agent is available", async () => {
    client.listAgents.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/No agents available/)).toBeTruthy();
    await waitFor(() => expect(startButton().disabled).toBe(true));
    expect(screen.getByRole("button", { name: /Manage agents/ })).toBeTruthy();
  });

  it("goes from the draft to Agent Ops as a root, keeping the prompt", async () => {
    setWideScreen(false);
    client.listAgents.mockResolvedValue([]);
    const user = userEvent.setup();
    renderDraftRootNavigation();
    await user.type(await screen.findByRole("textbox"), "Keep the draft");
    await user.click(screen.getByRole("button", { name: /Manage agents/ }));
    await screen.findByText("agent management");
    expect(window.location.pathname).toBe("/agents");
    // KIN-CONTINUE-002: this is a peer root, not a destination pushed over
    // the draft. The draft itself remains in durable local draft storage.
    expect(window.history.state.idx).toBe(0);
    expect(window.history.state.usr).toBeNull();
    expect(localStorage.getItem("kin_draft_prompt")).toBe("Keep the draft");
  });

  it("keeps the prompt when the remembered machine is offline and explains the block", async () => {
    localStorage.setItem("kin_draft_machine", "device-studio");
    client.listMachines.mockResolvedValue([STUDIO]);
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByRole("button", { name: /^Device & project: Studio · gamma/ }),
    ).toBeTruthy();
    await waitFor(() => expect(startButton().disabled).toBe(true));
    expect(screen.getByText("Studio is offline; work cannot be sent there.")).toBeTruthy();

    await user.type(promptBox(), "keep this");
    expect(promptBox().value).toBe("keep this");

    // The keyboard is blocked by the same reason the button is.
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(client.createTask).not.toHaveBeenCalled();

    // Choosing this machine again unblocks the same prompt.
    await user.click(placeRow());
    const panel = screen.getByRole("dialog", { name: "Device & project" });
    await user.click(within(panel).getByRole("option", { name: /alpha/ }));
    await waitFor(() => expect(startButton().disabled).toBe(false));
    expect(promptBox().value).toBe("keep this");
  });

  it("returns to this machine, keeping the prompt, when the remembered machine is gone", async () => {
    localStorage.setItem("kin_draft_machine", "device-old");
    localStorage.setItem("kin_draft_prompt", "keep me");
    renderPage();

    expect(await screen.findByText(/machine you last used is gone/)).toBeTruthy();
    expect(promptBox().value).toBe("keep me");
    await waitFor(() =>
      expect(placeRow().getAttribute("aria-label")).toBe("Device & project: This machine · alpha"),
    );
    // Home is usable again: the prompt was kept, so Start comes back on.
    await waitFor(() => expect(startButton().disabled).toBe(false));
  });

  it("goes back home and says so when the remembered project is gone", async () => {
    client.listMachines.mockResolvedValue([STUDIO_LIVE]);
    localStorage.setItem("kin_draft_machine", "device-studio");
    localStorage.setItem("kin_draft_cwd", "/srv/gone");
    localStorage.setItem("kin_draft_model", "opus");
    localStorage.setItem("kin_place_projects", JSON.stringify({ "device-studio": "/srv/gone" }));
    renderPage();

    expect(
      await screen.findByText("The project you last used is gone; back on this machine."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(placeRow().getAttribute("aria-label")).toBe("Device & project: This machine · alpha"),
    );
    // Coming home is a machine change: the run face goes with the machine.
    const face = screen.getByRole("button", { name: /^Run settings/ });
    await waitFor(() => expect(face.textContent).not.toContain("Opus"));
    expect(localStorage.getItem("kin_draft_model")).toBeNull();
  });

  it("drops a model that belonged to the machine being left", async () => {
    client.listMachines.mockResolvedValue([STUDIO_LIVE]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("button", { name: "Device & project: This machine · alpha" });
    await user.click(screen.getByRole("button", { name: /^Run settings/ }));
    await user.click(screen.getByRole("button", { name: /^Model/ }));
    await user.click(screen.getByRole("option", { name: /Opus/ }));
    expect(screen.getByRole("button", { name: /^Run settings/ }).textContent).toContain("Opus");

    await user.click(placeRow());
    const panel = screen.getByRole("dialog", { name: "Device & project" });
    await user.click(within(panel).getByRole("option", { name: /gamma/ }));

    // The landing machine offers the same model, so the face would still name
    // it; the stored draft is the observable that must be gone.
    await waitFor(() => expect(localStorage.getItem("kin_draft_model")).toBeNull());
  });

  it("converges the model once the machine list comes back", async () => {
    client.listMachines.mockRejectedValue(new Error("offline"));
    localStorage.setItem("kin_draft_machine", "device-studio");
    localStorage.setItem("kin_draft_cwd", "/srv/gamma");
    localStorage.setItem("kin_draft_model", "studio-ultra");
    renderPage();
    await waitFor(() => expect(startButton().disabled).toBe(true));
    expect(localStorage.getItem("kin_draft_model")).toBe("studio-ultra");

    // The retry answers with Studio's real ladder, which does not offer the
    // persisted model: the clamp must run again now that the machine is known.
    client.listMachines.mockResolvedValue([STUDIO_LIVE]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(localStorage.getItem("kin_draft_model")).toBeNull());
  });

  it("keeps the persisted model while the machine list cannot be read", async () => {
    client.listMachines.mockRejectedValue(new Error("offline"));
    localStorage.setItem("kin_draft_machine", "device-studio");
    localStorage.setItem("kin_draft_cwd", "/srv/gamma");
    localStorage.setItem("kin_draft_model", "studio-ultra");
    renderPage();

    await waitFor(() => expect(startButton().disabled).toBe(true));
    expect(localStorage.getItem("kin_draft_model")).toBe("studio-ultra");
  });

  it("does not carry a vanished machine's model onto this one", async () => {
    localStorage.setItem("kin_draft_machine", "device-old");
    localStorage.setItem("kin_draft_model", "opus");
    localStorage.setItem("kin_draft_prompt", "keep me");
    renderPage();

    expect(await screen.findByText(/machine you last used is gone/)).toBeTruthy();
    const face = screen.getByRole("button", { name: /^Run settings/ });
    await waitFor(() => expect(face.textContent).not.toContain("Opus"));
    expect(localStorage.getItem("kin_draft_model")).toBeNull();
  });

  it("keeps the chosen model when the page is left and opened again", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findByRole("button", { name: "Device & project: This machine · alpha" });
    await user.click(screen.getByRole("button", { name: /^Run settings/ }));
    await user.click(screen.getByRole("button", { name: /^Model/ }));
    await user.click(screen.getByRole("option", { name: /Opus/ }));
    first.unmount();

    renderPage();
    const face = await screen.findByRole("button", { name: /^Run settings/ });
    await waitFor(() => expect(face.textContent).toContain("Opus"));
  });

  it("starts a remote run with that machine and its own directory", async () => {
    client.listMachines.mockResolvedValue([STUDIO_LIVE]);
    localStorage.setItem("kin_draft_machine", "device-studio");
    localStorage.setItem("kin_draft_cwd", "/srv/gamma");
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("button", { name: /^Device & project: Studio · gamma/ });
    await user.type(promptBox(), "ship it");
    await waitFor(() => expect(startButton().disabled).toBe(false));
    await user.click(startButton());

    await waitFor(() => expect(client.createTask).toHaveBeenCalledTimes(1));
    const body = client.createTask.mock.calls[0][0] as Record<string, unknown>;
    expect(body.executing_device_id).toBe("device-studio");
    expect(body.cwd).toBe("/srv/gamma");
    expect(body.project_id).toBeUndefined();
  });

  it("restores the prompt and names the failure when creation fails", async () => {
    client.createTask.mockRejectedValue(new ApiError(500, "boom"));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("button", { name: "Device & project: This machine · alpha" });
    await user.type(promptBox(), "tidy the notes");
    await user.click(startButton());

    await waitFor(() => expect(client.createTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(promptBox().value).toBe("tidy the notes"));
    expect(localStorage.getItem("kin_draft_prompt")).toBe("tidy the notes");
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes("boom"))).toBe(
      true,
    );
  });

  it("keeps the remembered machine and blocks with the read's own reason when the list fails", async () => {
    client.listMachines.mockRejectedValue(new Error("offline"));
    localStorage.setItem("kin_draft_machine", "device-studio");
    localStorage.setItem("kin_draft_cwd", "/srv/gamma");
    localStorage.setItem("kin_draft_prompt", "keep me");
    renderPage();

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(
      /machine list could not be read, so only this machine can run work/i,
    );
    expect(screen.queryByText(/machine you last used is gone/)).toBeNull();
    await waitFor(() => expect(startButton().disabled).toBe(true));
    expect(promptBox().value).toBe("keep me");
  });

  it("asks for a place when the draft has none", async () => {
    client.recentCwds.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("Choose a working directory first")).toBeTruthy();
    await waitFor(() => expect(startButton().disabled).toBe(true));
  });

  it("prefers the project this machine was last used in", async () => {
    const online: MachineInfo = {
      ...STUDIO,
      reachability: "online",
      workspace_roots: ["/srv/gamma", "/srv/delta"],
    };
    client.listMachines.mockResolvedValue([online]);
    localStorage.setItem("kin_draft_machine", "device-studio");
    localStorage.setItem("kin_draft_cwd", "/elsewhere");
    localStorage.setItem("kin_place_projects", JSON.stringify({ "device-studio": "/srv/delta" }));
    renderPage();

    expect(
      await screen.findByRole("button", { name: "Device & project: Studio · delta" }),
    ).toBeTruthy();
  });

  it("blocks Start when the connection is down", async () => {
    useAppStore.setState({ wsStatus: "disconnected", reconnectGen: 0, toasts: [] });
    renderPage();
    expect(await screen.findByText(/you can start when the connection returns/)).toBeTruthy();
    await waitFor(() => expect(startButton().disabled).toBe(true));
  });

  it("keeps the draft and the chosen values while the phone run settings open and close", async () => {
    setWideScreen(false);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Device & project: This machine · alpha" });
    await user.type(promptBox(), "keep the draft");

    await user.click(screen.getByRole("button", { name: /^Run settings/ }));
    const sheet = await screen.findByRole("dialog", { name: "Run settings" });
    await user.click(within(sheet).getByRole("button", { name: /^Model/ }));
    await user.click(screen.getByRole("option", { name: /Opus/ }));
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull());
    expect(promptBox().value).toBe("keep the draft");
    expect(screen.getByRole("button", { name: /^Run settings/ }).textContent).toContain("Opus");
  });
});
