// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { importsInFlight, useAgentSessionImport } from "./useAgentSessionImport";
import { refreshMachines } from "./useMachines";
import { importAgentSessions, type AgentSessionImportResult } from "../api/client";
import type { Machine } from "../lib/devices";

/**
 * The rule this hook exists for is a rule about *time*: the busy flag has to be
 * true before the first await, because one of its callers is a 30 second timer
 * that cannot wait for a render to ask. That is not something the pure merge
 * functions can be asked about — they never see the flag — and it is exactly
 * what a plausible-looking refactor (read the flag from state, set it after the
 * machine list arrives) would break while every logic test stayed green.
 */

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, importAgentSessions: vi.fn() };
});

// The machine list is a network read that has nothing to do with the rule under
// test; what matters is which of its machines end up being asked.
vi.mock("./useMachines", () => ({ refreshMachines: vi.fn() }));

const here: Machine = {
  id: "desktop-hub",
  label: "hub",
  isSelf: true,
  online: true,
  roots: [],
  agents: [],
};

const laptop: Machine = {
  id: "desktop-laptop",
  label: "laptop",
  isSelf: false,
  online: true,
  roots: [],
  agents: [],
};

/** A promise the test resolves by hand, so "while it is running" is a state the
 *  test holds rather than a race it hopes to win. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const answered = (imported: number): AgentSessionImportResult => ({
  imported,
  providers: imported > 0 ? { codex: imported } : {},
});

beforeEach(() => {
  // The counter is module state shared by the whole console, so it outlives a
  // test. Starting from a known zero is what keeps a failure in one test from
  // turning into a mystery in the next.
  expect(importsInFlight()).toBe(false);
  vi.mocked(refreshMachines).mockResolvedValue([here, laptop]);
  vi.mocked(importAgentSessions).mockReset();
});

describe("the import hook", () => {
  it("raises the flag before the first await, and every surface sees it", async () => {
    const gate = deferred<AgentSessionImportResult>();
    vi.mocked(importAgentSessions).mockReturnValue(gate.promise);

    const { result } = renderHook(() => ({
      sidebar: useAgentSessionImport(),
      settings: useAgentSessionImport(),
    }));
    expect(result.current.sidebar.importing).toBe(false);

    let started!: Promise<AgentSessionImportResult>;
    act(() => {
      started = result.current.sidebar.importEveryMachine();
    });

    // Asked the way the automatic sync asks it: synchronously, with no render
    // in between. An import that began a moment ago has not rendered yet, and a
    // tick that waited for one would start a second fan-out over the first.
    expect(importsInFlight()).toBe(true);

    // The other surface is the settings page's own button, and it is a separate
    // hook instance on a separate page: it is disabled by the same flag or it is
    // not disabled at all.
    await waitFor(() => expect(result.current.settings.importing).toBe(true));
    expect(result.current.sidebar.importing).toBe(true);

    gate.resolve(answered(2));
    await act(async () => {
      await started;
    });

    // The stub answers the same two sessions from both machines, and four is
    // the count that comes back: the errand is one import over every machine,
    // and what it reports is sessions indexed, not machines asked.
    expect(await started).toEqual({ imported: 4, providers: { codex: 4 }, truncated: false });
    expect(result.current.sidebar.importing).toBe(false);
    expect(result.current.settings.importing).toBe(false);
    expect(importsInFlight()).toBe(false);
  });

  it("turns a machine that never answers into an error beside the result", async () => {
    vi.mocked(importAgentSessions).mockRejectedValue(new Error("machine is not connected"));

    const { result } = renderHook(() => useAgentSessionImport());
    let result_: AgentSessionImportResult | undefined;
    await act(async () => {
      result_ = await result.current.importEveryMachine();
    });

    // Not a rejection: a machine that cannot be reached is a result the caller
    // can show. The point of asserting the errors map is that the failure is
    // *reported* — a silently empty count reads as "you have no sessions".
    expect(result_?.imported).toBe(0);
    expect(Object.keys(result_?.errors ?? {})).toHaveLength(2);
    expect(importsInFlight()).toBe(false);
    expect(result.current.importing).toBe(false);
  });

  it("lowers the flag when the machine list itself cannot be read", async () => {
    // The read that sits *outside* the per-machine try/catch, and the one
    // failure this hook lets through. It is worth its own test because
    // beginImport() has already run by the time it fails, and `imports` is
    // module state with no reset: a counter left standing disables every import
    // control in the console — the sidebar, the settings button, the
    // per-provider rows, the automatic sync — until the page is reloaded.
    //
    // An unreachable Hub does not arrive here: useMachines absorbs that read and
    // degrades to this machine alone. What arrives is the store throwing on what
    // it was handed — a malformed entry in the list, a subscriber that throws
    // while being notified — and nothing between the two catches it.
    vi.mocked(refreshMachines).mockRejectedValue(new Error("hub is not connected"));

    const { result } = renderHook(() => useAgentSessionImport());
    let started!: Promise<AgentSessionImportResult>;
    act(() => {
      started = result.current.importEveryMachine();
    });

    // Up before the rejection lands. Without this the test cannot tell a flag
    // that came back down from one that was never raised.
    expect(importsInFlight()).toBe(true);
    const rejected = expect(started).rejects.toThrow("hub is not connected");
    await act(async () => {
      await rejected;
    });

    expect(importsInFlight()).toBe(false);
    expect(result.current.importing).toBe(false);
  });

  it("asks this machine alone when it was given provider names", async () => {
    vi.mocked(importAgentSessions).mockResolvedValue(answered(1));

    const { result } = renderHook(() => useAgentSessionImport());
    await act(async () => {
      await result.current.importEveryMachine(["codex"]);
    });

    // A named provider came out of this daemon's registry, so it is this
    // machine's provider. Asking the laptop by that name would ask it for
    // something it may not have, and "I have no codex" is not news about
    // anyone's sessions.
    expect(vi.mocked(importAgentSessions).mock.calls).toEqual([[["codex"], ""]]);

    vi.mocked(importAgentSessions).mockClear();
    await act(async () => {
      await result.current.importEveryMachine();
    });

    // No names is the other errand — "index my sessions" — and that one is
    // every machine, this one first.
    expect(vi.mocked(importAgentSessions).mock.calls).toEqual([
      [undefined, ""],
      [undefined, "desktop-laptop"],
    ]);
  });
});
