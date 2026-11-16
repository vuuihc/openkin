// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, AgentManagement, UsageRow } from "../../api/client";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";

/**
 * E4b: the Operations section speaks the shared facade.
 *
 * The catalog rows are the first half of the section to leave hand-built
 * controls behind: the `⋯` trigger is a `Button` and its panel is `Menu`, so
 * the keyboard contract (arrows, Home/End, typeahead, Escape, focus return,
 * one layer) is the console's rather than this file's. These tests drive the
 * real section so a regression in either half shows up here.
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
      fileURLToPath(new URL("./AgentOperationsSection.tsx", import.meta.url)),
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
