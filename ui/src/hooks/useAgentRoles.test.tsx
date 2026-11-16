// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLES_CHANGED_EVENT } from "../lib/agentRoles";

/**
 * The role list the composer's `/` menu lists.
 *
 * Roles are a settings key: the only writer is the settings page, and the
 * session host that reads them stays mounted across routes. So the contract is
 * one read per mount plus a re-read when a save announces itself — and nothing
 * after unmount, because a host that leaked its listener would keep a dead
 * component reading settings for the life of the tab.
 */

const client = vi.hoisted(() => ({ getSettings: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, ...client };
});

const { useAgentRoles } = await import("./useAgentRoles");

function stored(roles: unknown) {
  return { agent_roles: JSON.stringify(roles) };
}

/** A promise the test settles when it wants to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  client.getSettings.mockResolvedValue(
    stored([{ id: "review", name: "Review", prompt: "Be strict." }]),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAgentRoles", () => {
  it("reads the roles on mount and parses them", async () => {
    const { result } = renderHook(() => useAgentRoles());
    await waitFor(() => expect(result.current?.map((role) => role.id)).toEqual(["review"]));
    expect(client.getSettings).toHaveBeenCalledTimes(1);
  });

  it("offers nothing while the daemon has not answered", () => {
    client.getSettings.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAgentRoles());
    // Unknown, not empty: the composer says the roles cannot be read rather
    // than telling someone to re-add roles the daemon still has.
    expect(result.current).toBeNull();
  });

  it("stays unknown when the first read fails", async () => {
    client.getSettings.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useAgentRoles());
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getSettings).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it("reads again when a save announces itself", async () => {
    const { result } = renderHook(() => useAgentRoles());
    await waitFor(() => expect(result.current).toHaveLength(1));

    // A role is written on the settings route; this host never unmounts, so
    // without the announcement the new role would be invisible until reload.
    client.getSettings.mockResolvedValue(
      stored([
        { id: "review", name: "Review", prompt: "Be strict." },
        { id: "commit", name: "Commit", prompt: "Imperative." },
      ]),
    );
    act(() => {
      window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));
    });
    await waitFor(() =>
      expect(result.current?.map((role) => role.id)).toEqual(["review", "commit"]),
    );
  });

  it("stops listening once unmounted", async () => {
    const { unmount } = renderHook(() => useAgentRoles());
    await waitFor(() => expect(client.getSettings).toHaveBeenCalledTimes(1));
    unmount();
    window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));
    expect(client.getSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest answer when two reads overlap", async () => {
    // The mount read is slow; a save's re-read answers first. The slow answer
    // then belongs to a question nobody is asking any more.
    const slow = deferred<{ agent_roles: string }>();
    client.getSettings.mockReturnValueOnce(slow.promise);
    const { result } = renderHook(() => useAgentRoles());

    client.getSettings.mockResolvedValueOnce(
      stored([{ id: "fresh", name: "Fresh", prompt: "Written a moment ago." }]),
    );
    act(() => {
      window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));
    });
    await waitFor(() => expect(result.current?.map((role) => role.id)).toEqual(["fresh"]));

    await act(async () => {
      slow.resolve(stored([{ id: "stale", name: "Stale", prompt: "Read before the save." }]));
      await slow.promise;
    });
    expect(result.current?.map((role) => role.id)).toEqual(["fresh"]);
  });

  it("keeps the last list when a re-read fails", async () => {
    const { result } = renderHook(() => useAgentRoles());
    await waitFor(() => expect(result.current).toHaveLength(1));
    client.getSettings.mockRejectedValue(new Error("offline"));
    act(() => {
      window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));
    });
    await waitFor(() => expect(client.getSettings).toHaveBeenCalledTimes(2));
    // The daemon is unreachable, not empty-handed: the roles already on screen
    // stay there rather than blinking out mid-keystroke.
    expect(result.current?.map((role) => role.id)).toEqual(["review"]);
  });
});
