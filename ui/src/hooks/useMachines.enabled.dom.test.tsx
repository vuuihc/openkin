// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * The hook is no longer only mounted behind the console's gate: the sidebar
 * badge reads it from the app root, where the connect screen is still up. An
 * anonymous read can only 401, and the hook retries failed reads on a beat, so
 * a disabled consumer must not start one.
 */
const client = vi.hoisted(() => ({
  serverVersion: vi.fn(),
  listMachines: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, ...client };
});

const { resetMachinesCache, useMachines } = await import("./useMachines");

beforeEach(() => {
  resetMachinesCache();
  client.serverVersion.mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" });
  client.listMachines.mockResolvedValue([]);
  client.listAgents.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  resetMachinesCache();
});

describe("useMachines behind a closed gate", () => {
  it("does not read the machine list until it is enabled", async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMachines({ enabled }),
      { initialProps: { enabled: false } },
    );
    expect(client.serverVersion).not.toHaveBeenCalled();
    expect(client.listMachines).not.toHaveBeenCalled();
    expect(client.listAgents).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(client.listMachines).toHaveBeenCalledTimes(1));
  });
});
