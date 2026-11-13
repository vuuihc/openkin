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
const APP = readFileSync(join(UI, "src/App.tsx"), "utf8");

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

  it("opens on the device a notification named before the remembered one", () => {
    // A disabled-routine alert lands on /routines?device=<id>. The page must
    // prefer that once, and only fall back to the remembered machine with no
    // such parameter.
    expect(PAGE).toContain("searchParams.get(\"device\")?.trim() || readRoutineDevice()");
    expect(PAGE).toContain("const [searchParams, setSearchParams] = useSearchParams();");
  });

  it("keeps the Hub's task updates out of a remote machine's feed", () => {
    expect(PAGE).toContain("if (remoteRef.current) return;");
    // A run-now answered after the page moved belongs to the machine that was
    // showing, not the one that is.
    expect(PAGE).toMatch(
      /const t = await runRoutineNow\(r\.id, view\.deviceId\);[\s\S]*?if \(!isCurrentView\(view\)\) return;/,
    );
  });

  it("sends the machine with every routine request", () => {
    expect(PAGE).toContain(
      "listRoutines({ limit: 100, q: routineQuery.trim() || undefined }, deviceId)",
    );
    expect(PAGE).toContain("listRoutineRuns(80, deviceId)");
    expect(PAGE).toContain("patchRoutine(r.id, { enabled: !r.enabled }, deviceId)");
    expect(PAGE).toContain("deleteRoutine(r.id, deviceId)");
    expect(PAGE).toContain("runRoutineNow(r.id, view.deviceId)");
    expect(PAGE).toContain("markRoutineRunRead(taskId, view.deviceId)");
    expect(PAGE).toContain("markAllRoutineRunsRead(view.deviceId)");
    expect(PAGE).toContain("device={deviceId || undefined}");
  });

  it("opens a remote run where it lives, not in this Hub's task store", () => {
    // The run's id is a row in the machine's store. /tasks/:id asks the Hub and
    // would show "not found" for a row the reader just tapped, so a remote card
    // names the machine and the local page keeps its own link.
    expect(PAGE).toContain(
      "`/machines/${encodeURIComponent(device)}/tasks/${encodeURIComponent(run.id)}`",
    );
    expect(PAGE).toContain("`/tasks/${encodeURIComponent(run.id)}`");
    expect(PAGE).toContain("device={remote ? deviceId : undefined}");
    expect(APP).toContain('path="/machines/:device/tasks/:id"');
  });

  it("refreshes a live remote run on a slow beat, and only then", () => {
    // Another machine's task updates do not arrive on this Hub's WebSocket, so
    // the feed is re-read while something is running and stops when nothing is.
    expect(PAGE).toContain("if (!remote || !liveRun) return;");
    expect(PAGE).toContain("window.setInterval(() => void load(), 5_000)");
  });

  it("widens the retry instead of polling a sleeping machine forever", () => {
    // A page left open on an offline machine must keep trying, but the wait
    // grows to a ceiling and snaps back after a good load.
    expect(PAGE).toContain("retryDelay.current = Math.min(retryDelay.current * 2, 120_000);");
    expect(PAGE).toContain("retryDelay.current = 15_000;");
  });

  it("closes the form when the page changes machine", () => {
    // The form's cwd, agent, and model belong to the machine it was opened on.
    expect(PAGE).toContain("setShowCreate(false);");
    expect(PAGE).toContain('setCwd("");');
    expect(PAGE).toContain('setAgentId("");');
  });

  it("re-asks the badge when the page changes machine", () => {
    // The sidebar badge counts the machine this page shows; a switch that did
    // not tell it would leave the old machine's number there. The URL write now
    // sits between the persisted choice and the badge dispatch; both must still
    // happen.
    expect(PAGE).toContain("writeRoutineDevice(id);");
    expect(PAGE).toContain(
      'window.dispatchEvent(new Event("kin:routine-unread-changed"));',
    );
  });
});

describe("the sidebar badge and its machine", () => {
  it("counts the machine the routines page would open on", () => {
    // `routineDeviceForBadge` holds the rule; this pin proves the badge uses
    // it instead of asking the daemon's own store.
    expect(APP).toContain("routineDeviceForBadge(machines, readRoutineDevice(), loading, failed)");
    expect(APP).toContain("getRoutineUnreadCount(");
  });

  it("does not read the machine list before the gate is open", () => {
    // An anonymous machine-list read is a 401 loop; the shell mounts the same
    // hook once the console is through.
    expect(APP).toContain('enabled: auth.status === "ok"');
  });
});
