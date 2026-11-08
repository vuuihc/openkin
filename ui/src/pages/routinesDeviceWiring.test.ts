import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Routines page's machine state, guarded where a unit cannot reach.
 *
 * `routineDevice.test.ts` holds the choice rule and `client.routineDevice.test.ts`
 * holds the request. What is left is the page: that a failed machine list does
 * not overwrite the remembered machine, that a remote page never folds the
 * Hub's own task updates into its feed, and that the device travels with every
 * request. Mounting this page needs a daemon, a websocket, an agent list and a
 * router, so the guarantees are pinned in the source that implements them.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = readFileSync(join(UI, "src/pages/RoutinesPage.tsx"), "utf8");

describe("the routines page and its machine", () => {
  it("does not resolve a machine from a list that failed to load", () => {
    // The hook degrades a failed read to "this machine alone"; resolving
    // against that would overwrite a good remembered machine with the Hub and
    // bring back the empty page this change exists to fix.
    expect(PAGE).toContain(
      "if (machinesLoading || machinesFailed || deviceTouched.current) return;",
    );
    expect(PAGE).toContain("setDeviceId(resolved);");
    expect(PAGE).toContain("writeRoutineDevice(resolved);");
  });

  it("reads remoteness from the device id, not from the machine cache", () => {
    // A degraded cache must not turn a remote page into a local one: the run
    // links and the history read would then point at the Hub's own store.
    expect(PAGE).toContain("const remote = isRemoteDevice(deviceId) && !machine?.isSelf;");
  });

  it("keeps the Hub's task updates out of a remote machine's feed", () => {
    expect(PAGE).toContain("if (remoteRef.current) return;");
    // A run-now answered after the page moved belongs to the machine that was
    // showing, not the one that is.
    expect(PAGE).toContain("if (deviceRef.current !== at) return;");
  });

  it("sends the machine with every routine request", () => {
    expect(PAGE).toContain(
      "listRoutines({ limit: 100, q: routineQuery.trim() || undefined }, deviceId)",
    );
    expect(PAGE).toContain("listRoutineRuns(80, deviceId)");
    expect(PAGE).toContain("patchRoutine(r.id, { enabled: !r.enabled }, deviceId)");
    expect(PAGE).toContain("deleteRoutine(r.id, deviceId)");
    expect(PAGE).toContain("runRoutineNow(r.id, at)");
    expect(PAGE).toContain("markRoutineRunRead(taskId, deviceId)");
    expect(PAGE).toContain("markAllRoutineRunsRead(deviceId)");
    expect(PAGE).toContain("device={deviceId || undefined}");
  });

  it("widens the retry instead of polling a sleeping machine forever", () => {
    // A page left open on an offline machine must keep trying, but the wait
    // grows to a ceiling and snaps back after a good load.
    expect(PAGE).toContain(
      "retryDelay.current = Math.min(retryDelay.current * 2, 120_000);",
    );
    expect(PAGE).toContain("retryDelay.current = 15_000;");
  });

  it("closes the form when the page changes machine", () => {
    // The form's cwd, agent, and model belong to the machine it was opened on.
    expect(PAGE).toContain("setShowCreate(false);");
    expect(PAGE).toContain("setCwd(\"\");");
    expect(PAGE).toContain("setAgentId(\"\");");
  });
});
