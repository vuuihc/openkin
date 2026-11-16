// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, AgentManagement, UsageRow } from "../../api/client";
import { setLocale } from "../../i18n";
import { writeConnectedFamilies } from "../../lib/agentPageState";
import { useAppStore } from "../../store/appStore";

/**
 * E4b/E4c: the Operations section speaks the shared facade.
 *
 * The catalog rows were the first half of the section to leave hand-built
 * controls behind: the `⋯` trigger is a `Button` and its panel is `Menu`, so
 * the keyboard contract (arrows, Home/End, typeahead, Escape, focus return,
 * one layer) is the console's rather than this file's. E4c finished the rest —
 * discovery, manual import, the two banners, the phone action sheet, the
 * sortable headers — while the usage range picker keeps its raw roving
 * radiogroup because no Segmented/RadioGroup facade exists yet. These tests
 * drive the real section so a regression in either half shows up here.
 */

const client = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentManagement: vi.fn(),
  getUsageSummary: vi.fn(),
  getUsageLimits: vi.fn(),
  smokeAgents: vi.fn(),
  updateSettings: vi.fn(),
  importAgentSessions: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: client.listAgents,
    listAgentManagement: client.listAgentManagement,
    getUsageSummary: client.getUsageSummary,
    getUsageLimits: client.getUsageLimits,
    smokeAgents: client.smokeAgents,
    updateSettings: client.updateSettings,
    importAgentSessions: client.importAgentSessions,
  };
});

import AgentsPage from "./AgentOperationsSection";

function product(partial: Partial<AgentInfo> & Pick<AgentInfo, "id" | "name">): AgentInfo {
  return {
    installed: true,
    available: true,
    default: false,
    model_list_source: "none",
    model_list_status: "available",
    permission_modes: ["default"],
    ...partial,
  };
}

function management(
  partial: Partial<AgentManagement> & Pick<AgentManagement, "id">,
): AgentManagement {
  return { auth_status: "signed_in", version: "1.0.0", ...partial };
}

function usageRow(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    date: "2026-11-10",
    agent: "claude-code",
    tasks: 4,
    tokens_in: 1200,
    tokens_out: 800,
    cost_usd: 12.4,
    request_count: 6,
    reasoning_output_tokens: 0,
    cache_read_tokens: 400,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 1000,
    cache_hit_rate: 0.4,
    cache_coverage: 1,
    cache_status: "reported",
    ...partial,
  };
}

const claude = product({ id: "claude-code", name: "Claude Code", default: true });
const codex = product({ id: "codex", name: "Codex" });
const cursor = product({
  id: "cursor",
  name: "Cursor",
  installed: false,
  // A placeholder, never a real install endpoint.
  install_url: "https://install.example.com/cursor",
});

/** A control the shared facade owns: a real <button> carrying the facade surface. */
function expectFacade(el: HTMLElement, variant: "secondary" | "quiet" = "quiet") {
  expect(el.tagName).toBe("BUTTON");
  expect(el.className).toContain("kin-btn");
  if (variant === "secondary") expect(el.className).toContain("kin-btn-secondary");
  else expect(el.className).toContain("bg-transparent");
  expect(el.className).toContain("focus-visible:outline-kin-focus-ring");
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <AgentsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0, toasts: [] });
  for (const fn of Object.values(client)) fn.mockReset();
  client.listAgents.mockResolvedValue([claude, codex]);
  client.listAgentManagement.mockResolvedValue([
    management({ id: "claude-code" }),
    management({ id: "codex" }),
  ]);
  client.getUsageSummary.mockResolvedValue([usageRow()]);
  client.getUsageLimits.mockResolvedValue([]);
  client.smokeAgents.mockResolvedValue({ results: [] });
  client.updateSettings.mockResolvedValue({});
  client.importAgentSessions.mockResolvedValue({ imported: 0, providers: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The desktop row's `⋯`, scoped to the table so the phone twin cannot match. */
function rowTrigger(name: string): HTMLButtonElement {
  const table = screen.getByRole("table");
  return within(table).getByRole("button", {
    name: `Actions — ${name}`,
  }) as HTMLButtonElement;
}

async function renderLoaded() {
  const view = renderPage();
  expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
  return view;
}

const menuItem = (name: RegExp) => within(screen.getByRole("menu")).getByRole("menuitem", { name });

describe("the Operations section on the shared facade (E4b)", () => {
  it("opens the row menu from the keyboard and returns focus to its trigger on Escape", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const trigger = rowTrigger("Claude Code");

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(menuItem(/^Recheck/)));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // ArrowDown on a closed trigger opens the same menu at its first row.
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menu")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(menuItem(/^Recheck/)));
  });

  it("moves through the row menu with arrows, Home and End", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    rowTrigger("Claude Code").focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement).toBe(menuItem(/^Recheck/)));

    // Claude is the default, so "Remove from catalog" is disabled: it is in the
    // menu but never in the traversal.
    expect(menuItem(/^Remove from catalog/).getAttribute("aria-disabled")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem(/^Smoke test/));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem(/^Recheck/));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(menuItem(/^Smoke test/));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(menuItem(/^Recheck/));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(menuItem(/^Smoke test/));
  });

  it("closes the row menu on an outside pointer press without moving focus into the page", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const trigger = rowTrigger("Claude Code");
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(menuItem(/^Recheck/)));

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
    // Dismissal by an outside press is not a focus request: the layer must not
    // pull focus back to its trigger (Escape does that; the pointer does not).
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement).toBe(document.body);
  });

  it("labels the row menu with the agent's name and one menu layer", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    rowTrigger("Claude Code").focus();
    await user.keyboard("{Enter}");
    const first = await screen.findByRole("menu");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(first.getAttribute("aria-label")).toContain("Claude Code");
    for (const item of within(first).getAllByRole("menuitem")) {
      expect(item.getAttribute("role")).toBe("menuitem");
    }
    expect(document.querySelectorAll('[role="menu"] [role="menu"]')).toHaveLength(0);

    // Opening the sibling row's menu replaces the first rather than adding
    // a second one to the page.
    fireEvent.click(rowTrigger("Codex"));
    await waitFor(() => {
      const open = screen.getAllByRole("menu");
      expect(open).toHaveLength(1);
      expect(open[0].getAttribute("aria-label")).toContain("Codex");
    });
  });

  it("keeps the phone action trigger a 44px control that opens the same actions", async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const phone = screen
      .getAllByRole("button", { name: "Actions — Claude Code" })
      .find((button) => button.getAttribute("aria-haspopup") === "dialog") as HTMLButtonElement;
    expect(phone).toBeTruthy();
    expect(phone.className).toContain("h-11");
    expect(phone.className).toContain("w-11");
    expect(phone.getAttribute("aria-haspopup")).toBe("dialog");

    const labels = ["Recheck", "Smoke test", "Remove from catalog"];
    rowTrigger("Claude Code").focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    for (const label of labels) {
      expect(menuItem(new RegExp(`^${label}`))).toBeTruthy();
    }
    await user.keyboard("{Escape}");

    await user.click(phone);
    const sheet = await screen.findByRole("dialog", { name: "Claude Code" });
    for (const label of labels) {
      expect(within(sheet).getByRole("button", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
  });

  it("no blanket raw-button disable remains in the section", () => {
    // The ratchet: the file-wide disable is gone, and every raw button that is
    // still hand-built names itself and its follow-up in a line-level comment.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/settings/AgentOperationsSection.tsx"),
      "utf8",
    );
    expect(source).not.toContain("/* eslint-disable kin/no-raw-button");

    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("<button")) return;
      const above = lines.slice(Math.max(0, index - 2), index).join("\n");
      expect(
        above,
        `raw <button at line ${index + 1} needs an eslint-disable-next-line kin/no-raw-button`,
      ).toContain("eslint-disable-next-line kin/no-raw-button");
    });
  });
});

describe("the Operations section's remaining controls on the facade (E4c)", () => {
  it("the discovered list and its connect action are facade buttons", async () => {
    // One connected product leaves the other installed product discovered.
    writeConnectedFamilies(["claude-code"]);
    const first = await renderLoaded();

    const view = screen.getByRole("button", { name: "View" });
    expectFacade(view);
    expect(view.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(view);
    expect(view.getAttribute("aria-expanded")).toBe("true");

    // The discovery section's own Hide, not the header toggle (both say Hide).
    const discovery = screen.getByText("Discovered on this machine").closest("section")!;
    const hide = within(discovery).getByRole("button", { name: "Hide" });
    expectFacade(hide);
    expect(hide.className).toContain("text-kin-blue-ink");

    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expectFacade(connect, "secondary");
    expect(connect.disabled).toBe(false);
    first.unmount();

    // A full catalog disables Connect and keeps the reason in its `title`.
    localStorage.clear();
    const ten = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? claude : product({ id: `agent-${i}`, name: `Agent ${String(i).padStart(2, "0")}` }),
    );
    writeConnectedFamilies(ten.map((a) => a.id));
    client.listAgents.mockResolvedValue([...ten, codex]);
    const second = await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const full = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expectFacade(full, "secondary");
    expect(full.disabled).toBe(true);
    expect(full.getAttribute("title")).toBe(
      "The catalog is full. Remove or merge one before connecting another.",
    );
    second.unmount();

    // Offline is the other disabled reason; it carries no title.
    localStorage.clear();
    writeConnectedFamilies(["claude-code"]);
    client.listAgents.mockResolvedValue([claude, codex]);
    useAppStore.setState({ wsStatus: "disconnected", reconnectGen: 0, toasts: [] });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const offline = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expectFacade(offline, "secondary");
    expect(offline.disabled).toBe(true);
    expect(offline.getAttribute("title")).toBeNull();
  });

  it("install suggestions and the empty-state entry are facade buttons", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      // A stored-empty catalog with only uninstalled products: no discovery,
      // so the empty state offers install suggestions.
      writeConnectedFamilies([]);
      client.listAgents.mockResolvedValue([cursor]);
      const first = renderPage();
      expect(await screen.findByText("No agents yet")).toBeTruthy();
      const suggestion = screen.getByRole("button", { name: "Install Cursor" });
      expectFacade(suggestion, "secondary");
      fireEvent.click(suggestion);
      expect(open).toHaveBeenCalledWith(
        "https://install.example.com/cursor",
        "_blank",
        "noopener,noreferrer",
      );
      first.unmount();

      // An installed product is discovered instead, so the entry opens the
      // discovery list rather than an install URL.
      localStorage.clear();
      writeConnectedFamilies([]);
      client.listAgents.mockResolvedValue([codex, cursor]);
      const second = renderPage();
      expect(await screen.findByText("No agents yet")).toBeTruthy();
      const entry = screen.getByRole("button", { name: "Install an agent" });
      expectFacade(entry, "secondary");
      fireEvent.click(entry);
      expect(await screen.findByText("Discovered on this machine")).toBeTruthy();
      second.unmount();
    } finally {
      open.mockRestore();
    }
  });

  it("the smoke report dismiss and the usage-read banner are facade buttons", async () => {
    // A failed usage read keeps a retry that refetches.
    client.getUsageSummary.mockRejectedValue(new Error("usage down"));
    const first = renderPage();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expectFacade(retry);
    const before = client.getUsageSummary.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(client.getUsageSummary.mock.calls.length).toBeGreaterThan(before));
    first.unmount();

    // The smoke report's dismiss clears the report.
    localStorage.clear();
    client.getUsageSummary.mockResolvedValue([usageRow()]);
    client.smokeAgents.mockResolvedValue({
      results: [
        {
          id: "claude-code",
          name: "Claude Code",
          ok: true,
          installed: true,
          available: true,
        },
      ],
    });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Verify availability" }));
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    expectFacade(dismiss);
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull());
  });

  it("the row action sheet renders shared rows", async () => {
    await renderLoaded();
    const phone = screen
      .getAllByRole("button", { name: "Actions — Claude Code" })
      .find((button) => button.getAttribute("aria-haspopup") === "dialog") as HTMLButtonElement;
    fireEvent.click(phone);

    const sheet = await screen.findByRole("dialog", { name: "Claude Code" });
    const remove = within(sheet).getByRole("button", {
      name: /^Remove from catalog/,
    }) as HTMLButtonElement;
    expectFacade(remove);
    expect(remove.disabled).toBe(true);
    // A disabled action's reason stays on the surface the person is touching.
    expect(
      within(sheet).getByText(
        "The default agent stays in the catalog. Set another agent as default first.",
      ),
    ).toBeTruthy();

    const smoke = within(sheet).getByRole("button", { name: /^Smoke test/ });
    expectFacade(smoke);
    fireEvent.click(smoke);
    // The row runs only once the sheet is gone (KIN-CONTINUE-002). The suite
    // stubs `history.back`, so deliver the popstate the browser would send.
    expect(client.smokeAgents).not.toHaveBeenCalled();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(client.smokeAgents).toHaveBeenCalledWith(["claude-code"]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Claude Code" })).toBeNull());
  });

  it("sortable headers keep aria-sort and stay one focusable control per column", async () => {
    await renderLoaded();
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    const costTh = headers.find((th) => th.getAttribute("aria-sort") === "descending");
    expect(costTh).toBeTruthy();
    const nameTh = headers.find((th) => within(th).queryByRole("button", { name: /^Agent/ }));
    expect(nameTh?.getAttribute("aria-sort")).toBe("none");

    // One control per column, and it is the facade's.
    expect(within(costTh!).getAllByRole("button")).toHaveLength(1);
    const sortButton = within(costTh!).getByRole("button");
    expectFacade(sortButton);
    expect(sortButton.textContent).toContain("↓");

    fireEvent.click(within(nameTh!).getByRole("button", { name: /^Agent/ }));
    await waitFor(() => expect(nameTh?.getAttribute("aria-sort")).toBe("ascending"));
    expect(costTh?.getAttribute("aria-sort")).toBe("none");
    expect(within(nameTh!).getByRole("button").textContent).toContain("↑");
  });

  it("the usage range picker keeps one tab stop and moves with arrow keys", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const group = screen.getByRole("radiogroup", { name: "Usage range" });
    const week = within(group).getByRole("radio", { name: "This week" }) as HTMLButtonElement;
    const thirty = within(group).getByRole("radio", { name: "30 days" }) as HTMLButtonElement;
    const radios = within(group).getAllByRole("radio") as HTMLButtonElement[];

    expect(week.getAttribute("aria-checked")).toBe("true");
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([week]);

    week.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(thirty.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(thirty));
    expect(thirty.tabIndex).toBe(0);
    expect(week.tabIndex).toBe(-1);

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(document.activeElement).toBe(week));
    expect(week.getAttribute("aria-checked")).toBe("true");
  });

  it("leaves no E4c breadcrumb behind", () => {
    // The range picker is the one deliberate exemption, and it names the
    // primitive it is waiting for rather than an owner.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/settings/AgentOperationsSection.tsx"),
      "utf8",
    );
    const remaining = source
      .split("\n")
      .filter((line) => line.includes("E4c") || line.includes("(E4c)"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("range picker");
    expect(remaining[0]).toContain("RadioGroup");
  });
});
