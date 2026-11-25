// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, AgentLimitStatus, AgentManagement, UsageRow } from "../../api/client";
import { setLocale, t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import {
  readConnectedFamilies,
  readQuotaWaitSince,
  writeConnectedFamilies,
  writeQuotaWaitSince,
} from "../../lib/agentPageState";

/**
 * KIN-AGENTS-001: the agents console is a curated room, not a firehose.
 *
 * The daemon discovers seventy-odd products; the page holds ten and asks before
 * it adds an eleventh. Discovery is a prompt — opening the page connects
 * nothing and imports nothing. Each row says what it is in words, because
 * colour alone is not a status.
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

/** The shared snapshot `/new` names its host agent from, replaced so the save
 *  path's request to reload it is countable. */
const machines = vi.hoisted(() => ({ refreshMachines: vi.fn() }));

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

vi.mock("../../hooks/useMachines", () => ({
  refreshMachines: machines.refreshMachines,
}));

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

/**
 * A product Kin can host that is not connected yet: it has a permission
 * ladder, so Kin can run a turn in it once it is added to the catalog.
 */
function discoverable(partial: Partial<AgentInfo> & Pick<AgentInfo, "id" | "name">): AgentInfo {
  return product({
    available: false,
    reason: "detected; awaiting Kin maintainer smoke test before enabling",
    ...partial,
  });
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

function localMidnightISO(): string {
  const at = new Date();
  at.setHours(0, 0, 0, 0);
  return at.toISOString();
}

const claude = product({
  id: "claude-code",
  name: "Claude Code",
  default: true,
});
const codex = product({ id: "codex", name: "Codex" });
const cursor = discoverable({ id: "cursor", name: "Cursor" });

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
  // The sheet pushes and returns a history entry; jsdom would otherwise queue
  // a real traversal whose popstate can land in the next test (as documented
  // in Sheet.dom.test.tsx).
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0, toasts: [] });
  for (const fn of Object.values(client)) fn.mockReset();
  machines.refreshMachines.mockReset();
  // The import errand reads this snapshot too; an unreadable answer there would
  // turn every import into a failed test for the wrong reason.
  machines.refreshMachines.mockResolvedValue([]);
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

describe("the agents console (KIN-AGENTS-001)", () => {
  it("clips the vertical root scroller so the shell owns a blank-content tab swipe", () => {
    const { container } = renderPage();
    expect(container.firstElementChild?.className).toContain("overflow-x-hidden");
  });

  it("tells a signed-out agent apart from an available one and marks the default", async () => {
    client.listAgentManagement.mockResolvedValue([
      management({ id: "claude-code" }),
      management({
        id: "codex",
        auth_status: "not_signed_in",
        auth_detail: "/home/owner/.codex/auth.json",
      }),
    ]);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Available").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sign-in required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
    expect(screen.getByText("2 / 10 in catalog")).toBeTruthy();
  });

  it("offers an install entry when nothing is connected", async () => {
    // An empty stored catalog is a decision, not a first visit, so the seed
    // does not refill it. The one product on the machine is a discovery.
    writeConnectedFamilies([]);
    client.listAgents.mockResolvedValue([cursor]);
    renderPage();

    expect(await screen.findByText("No agents yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install an agent" }));
    expect(await screen.findByText("Discovered on this machine")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Cursor to catalog" })).toBeTruthy();
  });

  it("calls a runnable discovery available outside the catalog, not disconnected", async () => {
    // The daemon says the product is installed and available: Kin can run it
    // right now. The only missing step is a person's decision to spend one of
    // the ten slots, so the row must not read "Not connected".
    const gemini = product({ id: "gemini-cli", name: "Gemini CLI" });
    writeConnectedFamilies(["codex"]);
    client.listAgents.mockResolvedValue([gemini, codex]);
    renderPage();

    expect(await screen.findByText("1 / 10 in catalog")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "View" }));

    expect(await screen.findByText("Gemini CLI")).toBeTruthy();
    expect(screen.getByText("Available — not in your catalog")).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.getByRole("button", { name: "Add Gemini CLI to catalog" })).toBeTruthy();

    // The confirmation speaks the same verb.
    fireEvent.click(screen.getByRole("button", { name: "Add Gemini CLI to catalog" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Add Gemini CLI to the catalog?")).toBeTruthy();
    expect(readConnectedFamilies()).not.toContain("gemini");
  });

  it("keeps a discovery out of the catalog until the confirmation returns", async () => {
    writeConnectedFamilies(["claude", "codex"]);
    client.listAgents.mockResolvedValue([claude, codex, cursor]);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    // The catalog is the products Kin can host; the sighting is a prompt.
    expect(screen.queryAllByText("Cursor")).toHaveLength(0);
    expect(screen.getByText("1 discovered, not in the catalog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    fireEvent.click(screen.getByRole("button", { name: "Add Cursor to catalog" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Add Cursor to the catalog?")).toBeTruthy();
    expect(within(dialog).getByText(/does not import Cursor's history sessions/i)).toBeTruthy();
    // Cursor is installed but not available; the intro must not claim Kin can
    // already run it.
    expect(
      within(dialog).getByText("Kin found Cursor on this machine. It is not in your catalog yet."),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/already run/i)).toBeNull();
    // Reading the explanation changes nothing on its own.
    expect(screen.getAllByText("Cursor")).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Add Cursor to catalog" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Cursor", { selector: "span.font-medium" })).toBeTruthy();
    expect(client.importAgentSessions).not.toHaveBeenCalled();
    expect(readConnectedFamilies()).toContain("cursor");
  });

  it("keeps a failed add out of the catalog and offers a retry", async () => {
    writeConnectedFamilies(["claude", "codex"]);
    // The first read is fine; every read after it fails, so the confirmation's
    // reread is the one that breaks no matter how many reads the shell makes.
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex, cursor];
      throw new Error("daemon went away");
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Cursor to catalog" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Add Cursor to catalog" }));

    expect(
      await screen.findByText(/Couldn't add Cursor to the catalog: Error: daemon went away/),
    ).toBeTruthy();
    // The dialog stays open so the same button is the retry, and the catalog
    // did not grow a row that only exists because a request failed.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(readConnectedFamilies()).not.toContain("cursor");
    expect(screen.queryAllByText("Cursor", { selector: "span.font-medium" })).toHaveLength(0);
  });

  it("refuses an eleventh product and says what to do first", async () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      product({ id: `agent-${i}`, name: `Agent ${String(i).padStart(2, "0")}` }),
    );
    client.listAgents.mockResolvedValue([...ten, cursor]);
    renderPage();

    expect(await screen.findByText("10 / 10 in catalog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("The catalog is full. Remove one before adding another.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Add Cursor to catalog" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("imports nothing unless Import is pressed, then asks for this machine only", async () => {
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(client.importAgentSessions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Import sessions" }));
    await waitFor(() => expect(client.importAgentSessions).toHaveBeenCalledTimes(1));
    expect(client.importAgentSessions.mock.calls[0]).toEqual([undefined, ""]);
  });

  it("keeps the old numbers while a range loads, then reverts when it fails", async () => {
    let rejectNinety: (reason: Error) => void = () => {};
    client.getUsageSummary.mockImplementation(async (days: number) => {
      if (days === 90) {
        return new Promise((_resolve, reject) => {
          rejectNinety = reject;
        });
      }
      return [usageRow()];
    });
    renderPage();

    expect((await screen.findAllByText("$12.400")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));

    expect(await screen.findByText("Updating…")).toBeTruthy();
    // Not a skeleton: the last answer stays while the next one is asked for.
    expect(screen.getAllByText("$12.400").length).toBeGreaterThan(0);

    await act(async () => {
      rejectNinety(new Error("offline"));
    });

    expect(await screen.findByText("Couldn't load that range; showing the last one.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "This week" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(client.getUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("says an interval with no usage is empty rather than $0.00", async () => {
    client.getUsageSummary.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("No usage in this range")).toBeTruthy();
    expect(screen.queryByText("$0.000")).toBeNull();
  });

  it("calls the usage count a conversation on the operations tab", async () => {
    // The usage numbers must call the count a conversation: the tile, the
    // table header and the phone row share one name on one screen.
    setLocale("zh");
    renderPage();

    expect((await screen.findAllByText(t("usage.tasks"))).length).toBeGreaterThan(0);
    expect(screen.queryByText("任务")).toBeNull();
    expect(screen.getByText(new RegExp(t("agents.tasksCount", { count: 4 })))).toBeTruthy();
  });

  it("names the agent that failed the smoke test", async () => {
    client.smokeAgents.mockResolvedValue({
      results: [
        {
          id: "claude-code",
          name: "Claude Code",
          ok: true,
          installed: true,
          available: true,
          skipped: false,
        },
        {
          id: "codex",
          name: "Codex",
          ok: false,
          installed: true,
          available: false,
          skipped: false,
          detail: "Not logged in",
        },
        {
          id: "gemini-cli",
          name: "Gemini CLI",
          ok: true,
          installed: false,
          available: false,
          skipped: true,
        },
      ],
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Verify availability" }));

    expect(await screen.findByText("Failed: Codex — Not logged in")).toBeTruthy();
    expect(screen.getByText("1 passed · 1 failed · 1 skipped")).toBeTruthy();
  });

  it("disables actions offline and says the numbers are the last result", async () => {
    useAppStore.setState({ wsStatus: "disconnected" });
    renderPage();

    expect(await screen.findByText(/Offline · showing the last result/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Recheck all" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Import sessions" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("sorts with aria-sort and remembers the interval and the sort", async () => {
    const view = renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: "This week" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    const tokensHeader = screen.getByRole("columnheader", { name: /Tokens/ });
    fireEvent.click(within(tokensHeader).getByRole("button"));
    expect(tokensHeader.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "30 days" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );

    view.unmount();

    renderPage();
    expect(
      (await screen.findByRole("radio", { name: "30 days" })).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("columnheader", { name: /Tokens/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
  });

  it("removes a product from the catalog without uninstalling it", async () => {
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Codex" }));
    // The shared menu row's accessible name is its label plus the consequence
    // line the old `title` tooltip never exposed; match on the label prefix.
    fireEvent.click(screen.getByRole("menuitem", { name: /^Remove from catalog/ }));

    await waitFor(() => expect(screen.queryAllByText("Codex")).toHaveLength(0));
    expect(readConnectedFamilies()).not.toContain("codex");
    // The default agent stays: removing it without naming another default
    // would leave the picker without a selection.
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
    // Removal is a catalog decision, not an uninstall: the agent is still on
    // the machine, so it is offered for connecting again.
    expect(screen.getByText("1 discovered, not in the catalog")).toBeTruthy();
  });

  it("asks the shared machine snapshot to reload after setting a default here", async () => {
    // `/new` names its host agent from useMachines()' shared snapshot, not from
    // this table's list. A save here that only refreshed the table left `/new`
    // naming the previous agent for up to the snapshot's 30-second window.
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Set as default/ }));

    await waitFor(() =>
      expect(client.updateSettings).toHaveBeenCalledWith({ "agent.default": "codex" }),
    );
    await waitFor(() => expect(machines.refreshMachines).toHaveBeenCalledTimes(1));
  });

  it("does not reload the shared snapshot when the default save fails", async () => {
    client.updateSettings.mockRejectedValue(new Error("daemon went away"));
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Set as default/ }));

    // The error is the answer the person gets; the rejected write must not
    // reach the shared snapshot as if the old default were saved.
    await waitFor(() =>
      expect(
        useAppStore.getState().toasts.some((toast) => toast.message.includes("daemon went away")),
      ).toBe(true),
    );
    expect(machines.refreshMachines).not.toHaveBeenCalled();
  });

  it("labels a waiting agent with the time this console has watched", async () => {
    client.getUsageLimits.mockResolvedValue([
      {
        agent: "codex",
        status: "over",
        period_start: localMidnightISO(),
        used_spend_usd: 10,
        limit_spend_usd: 10,
        used_tokens: 0,
      } satisfies AgentLimitStatus,
    ]);
    writeQuotaWaitSince("codex", localMidnightISO(), Date.now() - 12 * 60_000);
    renderPage();

    expect(await screen.findByText("Waiting · 12 min")).toBeTruthy();
    // The phone card names the recovery instant, not just "when it recovers":
    // a time the person can plan around (local midnight after the period).
    expect(screen.getByText(/Waited 12 min · Back at /)).toBeTruthy();
  });

  it("retries a failed first usage read, then switches ranges normally", async () => {
    let calls = 0;
    client.getUsageSummary.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return [usageRow()];
    });
    renderPage();

    expect(await screen.findByText("Couldn't load that range; showing the last one.")).toBeTruthy();
    // Nothing loaded, so the retry is the only way out of the error state; it
    // must ask for the range the control shows (7), not arm the revert guard.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect((await screen.findAllByText("$12.400")).length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: "This week" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    await waitFor(() => expect(client.getUsageSummary.mock.calls.at(-1)).toEqual([30]));
    expect(client.getUsageSummary.mock.calls.map((c) => c[0])).toEqual([7, 7, 30]);
  });

  it("lets a range switch recover a failed first read", async () => {
    // The Retry button is one way out; choosing another range is the other.
    // Arming the revert guard on the first failure would swallow that switch
    // and leave the control saying 30 over numbers that never loaded.
    let calls = 0;
    client.getUsageSummary.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return [usageRow()];
    });
    renderPage();

    expect(await screen.findByText("Couldn't load that range; showing the last one.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));

    expect((await screen.findAllByText("$12.400")).length).toBeGreaterThan(0);
    expect(client.getUsageSummary.mock.calls.map((c) => c[0])).toEqual([7, 30]);
    expect(screen.getByRole("radio", { name: "30 days" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("reloads the range the control shows after a reconnect", async () => {
    // The switch is still in flight when the socket comes back, so the range
    // the numbers belong to (7) and the range the control shows (30) differ.
    // The reconnect must reload the one the person chose.
    client.getUsageSummary.mockImplementation(async (days: number) => {
      if (days === 30) return new Promise<UsageRow[]>(() => {});
      return [usageRow()];
    });
    renderPage();
    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "30 days" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );

    // Clear the switch's own call: the assertion below must be satisfied by a
    // new read, not by the request that was already in flight.
    client.getUsageSummary.mockClear();

    await act(async () => {
      useAppStore.setState({ reconnectGen: 1 });
    });

    // The reconnect effect reads `daysRef`, which the [days] effect keeps in
    // step; closing over the original `days` or the last loaded range would
    // reload the wrong interval.
    await waitFor(() => expect(client.getUsageSummary.mock.calls).toEqual([[30]]));
  });

  it("re-reads the limits with Recheck, not only on arrival", async () => {
    client.getUsageLimits.mockResolvedValueOnce([]).mockResolvedValue([
      {
        agent: "codex",
        status: "over",
        period_start: localMidnightISO(),
        used_spend_usd: 10,
        limit_spend_usd: 10,
        used_tokens: 0,
      } satisfies AgentLimitStatus,
    ]);
    writeQuotaWaitSince("codex", localMidnightISO(), Date.now() - 12 * 60_000);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Waiting · 12 min")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Recheck all" }));

    expect(await screen.findByText("Waiting · 12 min")).toBeTruthy();
  });

  it("adds a family's usage into the one row that product shows", async () => {
    // The daemon records usage under the transport that ran the turn; the
    // catalog shows one row per product. A row keyed by the displayed id would
    // read zero for every ACP turn.
    client.getUsageSummary.mockResolvedValue([usageRow({ agent: "claude-acp", cost_usd: 5.25 })]);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    // Scoped to the table row: the stat tile would show $5.250 even when the
    // row is keyed under a transport no catalog row displays.
    const table = screen.getByRole("table");
    const row = within(table)
      .getAllByRole("row")
      .find((candidate) => within(candidate).queryByText("Claude Code"));
    expect(row).toBeTruthy();
    expect(within(row!).getByText("$5.250")).toBeTruthy();
  });

  it("does not store an empty catalog when the first read finds nothing", async () => {
    client.listAgents.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("No agents yet")).toBeTruthy();
    // Writing `[]` here would freeze "no hostable products at first launch" as
    // "the person removed everything", and a later install would never seed.
    expect(readConnectedFamilies()).toBeNull();
  });

  it("shows a stored family the machine lost and frees its slot", async () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      product({ id: `agent-${i}`, name: `Agent ${i}` }),
    );
    writeConnectedFamilies([...nine.map((a) => a.id), "vanished"]);
    client.listAgents.mockResolvedValue([...nine, cursor]);
    renderPage();

    expect(
      await screen.findByText("1 product(s) in the catalog this machine no longer reports"),
    ).toBeTruthy();
    // The header and the cap count the same slots: ten, not the nine rows.
    expect(screen.getByText("10 / 10 in catalog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    // Nine rows plus the lost family is ten slots: the catalog is full, and a
    // hole nobody can see would otherwise block every new product forever.
    expect(
      (screen.getByRole("button", { name: "Add Cursor to catalog" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove vanished" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Add Cursor to catalog" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(readConnectedFamilies()).not.toContain("vanished");
    expect(
      screen.queryByText("1 product(s) in the catalog this machine no longer reports"),
    ).toBeNull();
  });

  it("cancels a connect that is still in flight", async () => {
    writeConnectedFamilies(["claude", "codex"]);
    const deferred: { resolve: ((list: AgentInfo[]) => void) | null } = { resolve: null };
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex, cursor];
      return new Promise<AgentInfo[]>((resolve) => {
        deferred.resolve = resolve;
      });
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Cursor to catalog" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Cursor to catalog" }));

    // Cancel is a decision: the answer that arrives later must not add it.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readConnectedFamilies()).not.toContain("cursor");

    expect(deferred.resolve).toBeTruthy();
    await act(async () => {
      deferred.resolve!([claude, codex, cursor]);
    });

    expect(readConnectedFamilies()).not.toContain("cursor");
    expect(screen.queryAllByText("Cursor", { selector: "span.font-medium" })).toHaveLength(0);
    // And no late "connected" toast for a request the person canceled.
    expect(
      useAppStore
        .getState()
        .toasts.some((toast) => toast.message === "Cursor added to the catalog"),
    ).toBe(false);
  });

  it("does not connect a product the machine stopped reporting", async () => {
    writeConnectedFamilies(["claude", "codex"]);
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex, cursor];
      // Between discovery and confirmation the product vanished.
      return [claude, codex];
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Cursor to catalog" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Cursor to catalog" }));

    expect(
      await screen.findByText(
        "Couldn't add Cursor to the catalog: this machine no longer reports it",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(readConnectedFamilies()).not.toContain("cursor");
  });

  it("drops a connect answer that a newer read has already replaced", async () => {
    writeConnectedFamilies(["claude", "codex"]);
    const deferred: { resolve: ((list: AgentInfo[]) => void) | null } = { resolve: null };
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex, cursor];
      if (reads === 2) {
        return new Promise<AgentInfo[]>((resolve) => {
          deferred.resolve = resolve;
        });
      }
      // The reconnect's read: newer, and the default has moved to Codex.
      return [{ ...claude, default: false }, { ...codex, default: true }, cursor];
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Cursor to catalog" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Cursor to catalog" }));

    await act(async () => {
      useAppStore.setState({ reconnectGen: 1 });
    });
    const table = screen.getByRole("table");
    const rowFor = (name: string) =>
      within(table)
        .getAllByRole("row")
        .find((candidate) => within(candidate).queryByText(name));
    await waitFor(() => expect(within(rowFor("Codex")!).getByText("Default")).toBeTruthy());

    expect(deferred.resolve).toBeTruthy();
    await act(async () => {
      deferred.resolve!([claude, codex, cursor]);
    });

    // The connect itself completed (sheet closed), but its older list must not
    // roll the catalog back to the pre-reconnect default.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(rowFor("Codex")!).getByText("Default")).toBeTruthy();
    expect(within(rowFor("Claude Code")!).queryByText("Default")).toBeNull();
  });

  it("keeps a newer per-agent check marked while an older one lands", async () => {
    const resolvers: Array<(list: AgentInfo[]) => void> = [];
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex];
      return new Promise<AgentInfo[]>((resolve) => resolvers.push(resolve));
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Claude Code" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Recheck" }));
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Recheck" }));

    const rowFor = (name: string) =>
      within(table)
        .getAllByRole("row")
        .find((candidate) => within(candidate).queryByText(name));
    expect(resolvers).toHaveLength(2);
    expect(within(rowFor("Codex")!).getByText("Checking…")).toBeTruthy();

    // Claude's slower answer lands while Codex is still being checked; the
    // older one finishing must not un-mark the newer row.
    await act(async () => {
      resolvers[0]([claude, codex]);
    });

    expect(within(rowFor("Codex")!).getByText("Checking…")).toBeTruthy();
    await act(async () => {
      resolvers[1]([claude, codex]);
    });
    expect(within(rowFor("Codex")!).queryByText("Checking…")).toBeNull();
  });

  it("keeps a newer per-agent smoke marked while an older one lands", async () => {
    const resolvers: Array<(list: AgentInfo[]) => void> = [];
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex];
      return new Promise<AgentInfo[]>((resolve) => resolvers.push(resolve));
    });
    client.smokeAgents.mockResolvedValue({ results: [] });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    const table = screen.getByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Claude Code" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Smoke test" }));
    fireEvent.click(within(table).getByRole("button", { name: "Actions — Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Smoke test" }));

    const rowFor = (name: string) =>
      within(table)
        .getAllByRole("row")
        .find((candidate) => within(candidate).queryByText(name));
    // Each smoke answers first, then refreshes; let both reach their refresh.
    await waitFor(() => expect(resolvers).toHaveLength(2));
    expect(within(rowFor("Codex")!).getByText("Checking…")).toBeTruthy();

    await act(async () => {
      resolvers[0]([claude, codex]);
    });

    // Claude's refresh lands first; Codex's own smoke is still running.
    expect(within(rowFor("Codex")!).getByText("Checking…")).toBeTruthy();

    await act(async () => {
      resolvers[1]([claude, codex]);
    });
    expect(within(rowFor("Codex")!).queryByText("Checking…")).toBeNull();
  });

  it("drops a recheck answer that a newer read has already replaced", async () => {
    const deferred: { resolve: ((list: AgentInfo[]) => void) | null } = { resolve: null };
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [claude, codex];
      if (reads === 2) {
        return new Promise<AgentInfo[]>((resolve) => {
          deferred.resolve = resolve;
        });
      }
      return [
        { ...claude, default: false },
        { ...codex, default: true },
      ];
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    // The recheck was asked first and is slow.
    fireEvent.click(screen.getByRole("button", { name: "Recheck all" }));

    // A reconnect is allowed while the recheck runs; its read returns newer
    // state (the default moved to Codex) and commits first.
    await act(async () => {
      useAppStore.setState({ reconnectGen: 1 });
    });

    const table = screen.getByRole("table");
    const rowFor = (name: string) =>
      within(table)
        .getAllByRole("row")
        .find((candidate) => within(candidate).queryByText(name));
    await waitFor(() => expect(within(rowFor("Codex")!).getByText("Default")).toBeTruthy());

    // The slow recheck now answers with the pre-change catalog. It is older
    // than the read the reconnect already committed, so it must lose.
    expect(deferred.resolve).toBeTruthy();
    await act(async () => {
      deferred.resolve!([claude, codex]);
    });

    expect(within(rowFor("Codex")!).getByText("Default")).toBeTruthy();
    expect(within(rowFor("Claude Code")!).queryByText("Default")).toBeNull();
  });

  it("keeps the smoke outcome when the follow-up refresh fails", async () => {
    let reads = 0;
    client.listAgents.mockImplementation(async () => {
      reads += 1;
      if (reads >= 2) throw new Error("daemon restarted");
      return [claude, codex];
    });
    client.smokeAgents.mockResolvedValue({
      results: [
        {
          id: "claude-code",
          name: "Claude Code",
          ok: true,
          installed: true,
          available: true,
          skipped: false,
        },
        {
          id: "codex",
          name: "Codex",
          ok: false,
          installed: true,
          available: false,
          skipped: false,
          detail: "Not logged in",
        },
        {
          id: "gemini-cli",
          name: "Gemini CLI",
          ok: true,
          installed: false,
          available: false,
          skipped: true,
        },
      ],
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Verify availability" }));

    // The per-agent outcome is the answer; a failed rows refresh must not
    // replace it with one error line.
    expect(await screen.findByText("Failed: Codex — Not logged in")).toBeTruthy();
    expect(screen.getByText("1 passed · 1 failed · 1 skipped")).toBeTruthy();
  });

  it("marks the default product when its sibling variant is the one shown", async () => {
    const native = product({ id: "claude-code", name: "Claude Code" });
    // The setting points at the ACP transport; collapse displays the native one.
    const acp = product({ id: "claude-acp", name: "Claude Code (ACP)", default: true });
    client.listAgents.mockResolvedValue([native, acp]);
    client.listAgentManagement.mockResolvedValue([
      management({ id: "claude-code" }),
      management({ id: "claude-acp" }),
    ]);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Claude Code (ACP)")).toHaveLength(0);
    const table = screen.getByRole("table");
    const row = within(table)
      .getAllByRole("row")
      .find((candidate) => within(candidate).queryByText("Claude Code"));
    expect(within(row!).getByText("Default")).toBeTruthy();

    fireEvent.click(within(row!).getByRole("button", { name: "Actions — Claude Code" }));
    // Removing the family would remove the agent the setting names. A menu row
    // is a `menuitem` div in the shared facade, so "disabled" is aria-disabled.
    expect(
      screen.getByRole("menuitem", { name: /^Remove from catalog/ }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("stops presenting the last auth state when the probe fails", async () => {
    // One successful probe, then a failing one. Keeping the old answer would
    // say "Signed in" for a session nobody just verified.
    let probes = 0;
    client.listAgentManagement.mockImplementation(async () => {
      probes += 1;
      if (probes === 1) {
        return [management({ id: "claude-code" }), management({ id: "codex" })];
      }
      throw new Error("probe timed out");
    });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Signed in").length).toBeGreaterThan(0);

    await act(async () => {
      useAppStore.setState({ reconnectGen: 1 });
    });

    await waitFor(() => expect(screen.getAllByText("Auth unknown").length).toBeGreaterThan(0));
    expect(screen.queryAllByText("Signed in")).toHaveLength(0);
  });

  it("does not call stored products missing while the first read is in flight", () => {
    writeConnectedFamilies(["claude", "codex"]);
    // Never answers: the page must not present the empty agent list as fact.
    client.listAgents.mockImplementation(() => new Promise<AgentInfo[]>(() => {}));
    renderPage();

    expect(screen.queryByText(/no longer reports/)).toBeNull();
  });

  it("does not read everything twice when it mounts after a reconnect", async () => {
    // The store keeps the reconnect counter; a page opened afterwards would
    // treat it as a new event and issue a second pair of reads.
    useAppStore.setState({ reconnectGen: 3 });
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    expect(client.listAgents).toHaveBeenCalledTimes(1);
    expect(client.getUsageSummary).toHaveBeenCalledTimes(1);
  });

  it("records the first time it sees a quota wait", async () => {
    client.getUsageLimits.mockResolvedValue([
      {
        agent: "codex",
        status: "over",
        period_start: localMidnightISO(),
        used_spend_usd: 10,
        limit_spend_usd: 10,
        used_tokens: 0,
      } satisfies AgentLimitStatus,
    ]);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    // Without this write the page could never say "waited 12 minutes" after a
    // reload; every later read would start the clock again.
    expect(readQuotaWaitSince("codex", localMidnightISO())).not.toBeNull();
  });

  it("moves focus into the connect dialog and closes it with Esc", async () => {
    writeConnectedFamilies(["claude"]);
    client.listAgents.mockResolvedValue([claude, cursor]);
    renderPage();

    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Cursor to catalog" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Nothing was connected by opening and closing the explanation.
    expect(readConnectedFamilies()).not.toContain("cursor");
  });

  it("opens the phone's agent actions as the shared sheet with the remove reason on the row", async () => {
    renderPage();
    expect((await screen.findAllByText("Claude Code")).length).toBeGreaterThan(0);

    // The phone block and the desktop table both render in jsdom (`md:hidden`
    // is CSS only) and share the trigger's name; the table's copy is the
    // desktop menu button, so take the one outside it.
    const table = screen.getByRole("table");
    const trigger = screen
      .getAllByRole("button", { name: "Actions — Claude Code" })
      .find((button) => !table.contains(button));
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger!);

    const dialog = await screen.findByRole("dialog", { name: "Claude Code" });
    // A disabled row cannot be focused, so its reason has to be on the sheet.
    const remove = within(dialog).getByRole("button", { name: /^Remove from catalog/ });
    expect(remove.hasAttribute("disabled")).toBe(true);
    expect(
      within(dialog).getByText(
        "The default agent stays in the catalog. Set another agent as default first.",
      ),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Claude Code" })).toBeNull());
    // Cancel only dismisses: the default agent is still in the catalog.
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
  });
});
