import { describe, expect, it } from "vitest";
import type { AgentInfo, DeviceInfo } from "../api/client";
import {
  canRunTasks,
  catalogFor,
  cwdAfterMachineChange,
  cwdPickerMode,
  cwdSuggestions,
  defaultAgentOn,
  findMachine,
  folderPickable,
  isDirtyRefusal,
  machineLabelFor,
  machineList,
  machineRef,
  remoteMachine,
} from "./devices";

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "claude-code",
    name: "Claude Code",
    installed: true,
    available: true,
    default: false,
    model_list_source: "none",
    model_list_status: "unavailable",
    ...over,
  };
}

function device(over: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: "node-1",
    label: "studio",
    reachability: "online",
    created_at: 1,
    agents: [
      { id: "codex", installed: true, available: true, is_default: true },
      { id: "grok", installed: true, available: false, reason: "not signed in" },
    ],
    workspace_roots: ["/code/kin"],
    ...over,
  };
}

const SELF = { id: "desk-1", name: "Work Mac" };

describe("machineList", () => {
  it("puts this machine first, with the local registry as its agents", () => {
    const machines = machineList(
      [device()],
      SELF,
      [agent({ id: "kin", name: "Kin", default: true }), agent({ id: "codex", available: false })],
    );
    expect(machines[0]).toMatchObject({ id: "desk-1", label: "Work Mac", isSelf: true, online: true });
    expect(machines[0].agents).toEqual([
      { id: "kin", installed: true, available: true, reason: undefined, isDefault: true },
      { id: "codex", installed: true, available: false, reason: undefined, isDefault: false },
    ]);
    expect(machines[1]).toMatchObject({ id: "node-1", label: "studio", isSelf: false });
    expect(machines[1].roots).toEqual(["/code/kin"]);
    expect(machines[1].agents).toEqual([
      { id: "codex", installed: true, available: true, reason: undefined, isDefault: true },
      { id: "grok", installed: true, available: false, reason: "not signed in", isDefault: undefined },
    ]);
  });

  it("keeps the daemon itself out of the other-machines list", () => {
    // The Hub's own device row and /api/version describe one machine. Listing it
    // twice would offer the same machine as if it were somewhere else.
    const machines = machineList([device({ id: "desk-1", label: "Work Mac" })], SELF, [agent()]);
    expect(machines).toHaveLength(1);
    expect(machines[0].isSelf).toBe(true);
  });

  it("drops revoked machines and sorts the rest by who can work now", () => {
    const machines = machineList(
      [
        device({ id: "z-off", label: "zulu", reachability: "offline" }),
        device({ id: "a-on", label: "alpha", reachability: "online" }),
        device({ id: "b-gone", label: "revoked", revoked_at: 5 }),
        device({ id: "m-unknown", label: "mike", reachability: "unknown" }),
      ],
      SELF,
      [],
    );
    expect(machines.map((m) => m.id)).toEqual(["desk-1", "a-on", "m-unknown", "z-off"]);
    expect(machines.find((m) => m.id === "z-off")?.online).toBe(false);
  });

  it("falls back to the id when a machine has no label", () => {
    const machines = machineList([device({ id: "node-9", label: "" })], SELF, []);
    expect(machines[1].label).toBe("node-9");
  });
});

describe("machineLabelFor", () => {
  const machines = machineList([device()], SELF, []);

  it("reads an empty id as this machine", () => {
    expect(machineLabelFor(machines, undefined)).toEqual({ text: "", isSelf: true, known: true });
    expect(machineLabelFor(machines, "  ")).toEqual({ text: "", isSelf: true, known: true });
    expect(machineLabelFor(machines, "desk-1")).toEqual({ text: "Work Mac", isSelf: true, known: true });
  });

  it("names a machine it knows, and flags one it does not", () => {
    expect(machineLabelFor(machines, "node-1")).toEqual({ text: "studio", isSelf: false, known: true });
    // A task whose machine was revoked must not be dressed up as local.
    expect(machineLabelFor(machines, "node-2")).toEqual({ text: "node-2", isSelf: false, known: false });
  });

  it("finds a machine by id, and nothing for an empty id", () => {
    expect(findMachine(machines, "node-1")?.label).toBe("studio");
    expect(findMachine(machines, undefined)).toBeUndefined();
    expect(findMachine(machines, "")).toBeUndefined();
  });
});

describe("cwdSuggestions", () => {
  const machines = machineList([device()], SELF, []);
  const self = machines[0];
  const remote = machines[1];

  it("suggests this machine's recent directories here, and the machine's own roots there", () => {
    expect(cwdSuggestions(self, ["/Users/me/code"])).toEqual(["/Users/me/code"]);
    expect(cwdSuggestions(remote, ["/Users/me/code"])).toEqual(["/code/kin"]);
  });

  it("suggests nothing when a machine declared no roots", () => {
    const bare = machineList([device({ workspace_roots: [] })], SELF, [])[1];
    expect(cwdSuggestions(bare, ["/Users/me/code"])).toEqual([]);
    // Before the machine list has loaded, nothing is known: stay with local.
    expect(cwdSuggestions(undefined, ["/Users/me/code"])).toEqual(["/Users/me/code"]);
  });
});

describe("cwdAfterMachineChange", () => {
  it("replaces a suggestion that belongs to the machine just left", () => {
    expect(cwdAfterMachineChange("/code/kin", ["/code/kin"], ["/srv/app"])).toBe("/srv/app");
  });

  it("keeps a path the user typed themselves", () => {
    expect(cwdAfterMachineChange("/tmp/scratch", ["/code/kin"], ["/srv/app"])).toBe("/tmp/scratch");
  });

  it("clears the field when the new machine suggests nothing", () => {
    expect(cwdAfterMachineChange("/code/kin", ["/code/kin"], [])).toBe("");
    expect(cwdAfterMachineChange("   ", [], ["/srv/app"])).toBe("/srv/app");
  });
});

describe("defaultAgentOn", () => {
  it("prefers the machine's default, then any available agent", () => {
    const machines = machineList([device()], SELF, []);
    expect(defaultAgentOn(machines[1])?.id).toBe("codex");
    const noDefault = machineList(
      [device({ agents: [{ id: "grok", installed: true, available: true }] })],
      SELF,
      [],
    )[1];
    expect(defaultAgentOn(noDefault)?.id).toBe("grok");
  });

  it("has no answer for a machine with nothing runnable, or for no machine", () => {
    const empty = machineList(
      [device({ agents: [{ id: "codex", installed: true, available: false, reason: "signed out" }] })],
      SELF,
      [],
    )[1];
    expect(defaultAgentOn(empty)).toBeUndefined();
    expect(defaultAgentOn(undefined)).toBeUndefined();
  });
});

describe("canRunTasks", () => {
  it("is true only for a machine that is reachable now", () => {
    const machines = machineList(
      [
        device({ id: "node-1", reachability: "online" }),
        device({ id: "node-2", reachability: "offline" }),
      ],
      SELF,
      [],
    );
    expect(canRunTasks(machines[0])).toBe(true);
    expect(canRunTasks(machines[1])).toBe(true);
    expect(canRunTasks(machines[2])).toBe(false);
    expect(canRunTasks(undefined)).toBe(false);
  });
});

describe("remoteMachine", () => {
  const machines = machineList([device()], SELF, []);

  it("names the machine only when the task runs somewhere else", () => {
    expect(remoteMachine(machines, "node-1")).toEqual({ text: "studio", known: true });
    // Runs here, or no machine recorded: nothing to explain to the reader.
    expect(remoteMachine(machines, "desk-1")).toBeNull();
    expect(remoteMachine(machines, undefined)).toBeNull();
    expect(remoteMachine(machines, "")).toBeNull();
  });

  it("still names a machine the console can no longer see", () => {
    // A revoked machine must not read as "local" just because it is missing.
    expect(remoteMachine(machines, "node-9")).toEqual({ text: "node-9", known: false });
  });
});

describe("catalogFor", () => {
  const local: AgentInfo[] = [agent({ id: "kin", name: "Kin", default: true })];
  const machines = machineList([device()], SELF, local);

  it("is the local registry for this machine", () => {
    expect(catalogFor(machines[0], local)).toBe(local);
    // Before the machine list has loaded nothing is known: stay with local.
    expect(catalogFor(undefined, local)).toBe(local);
  });

  it("is exactly what the other machine reported, named as elsewhere", () => {
    // The Hub validates a dispatched agent against this list, so offering
    // anything more would turn a click into a rejected request.
    expect(catalogFor(machines[1], local)).toEqual([
      {
        id: "codex",
        name: "Codex",
        kind: "cli",
        capabilities: [],
        installed: true,
        available: true,
        default: true,
        reason: undefined,
        model_list_source: "none",
        model_list_status: "unavailable",
      },
      {
        id: "grok",
        name: "Grok",
        kind: "cli",
        capabilities: [],
        installed: true,
        available: false,
        default: false,
        reason: "not signed in",
        model_list_source: "none",
        model_list_status: "unavailable",
      },
    ]);
  });
});

describe("cwdPickerMode", () => {
  it("uses the native dialog only where a native filesystem is the right answer", () => {
    // The rule the cwd control turns on: the native dialog reads the filesystem
    // this console is running on, so it can only ever answer about this machine.
    expect(cwdPickerMode(true, undefined)).toBe("native");
    expect(cwdPickerMode(true, "")).toBe("native");
    expect(cwdPickerMode(true, "self")).toBe("native");
    // A phone or a browser has no such dialog to open.
    expect(cwdPickerMode(false, undefined)).toBe("browse");
    // And a form aimed at another machine must ask that machine, even from the
    // desktop app — the directories are on that machine, not this one.
    expect(cwdPickerMode(true, "device-abc")).toBe("browse");
  });
});

describe("machineRef", () => {
  it("names this machine the way the machine endpoints do", () => {
    // An empty id and "self" are one machine; picking the literal keeps the id
    // out of a path where it would read as a double slash.
    expect(machineRef(undefined)).toBe("self");
    expect(machineRef("")).toBe("self");
    expect(machineRef("  ")).toBe("self");
    expect(machineRef("self")).toBe("self");
    expect(machineRef("device-abc")).toBe("device-abc");
    // A device id is somebody else's string and ends up in a path.
    expect(machineRef("device/../abc")).toBe("device%2F..%2Fabc");
  });
});

describe("folderPickable", () => {
  const ok = { path: "/srv/app", loading: false, failed: false };

  it("accepts a directory the machine has listed", () => {
    expect(folderPickable(ok)).toBe(true);
  });

  it("refuses while the listing is still in flight", () => {
    expect(folderPickable({ ...ok, loading: true })).toBe(false);
  });

  it("refuses a listing that failed, because the path is not known to be there", () => {
    expect(folderPickable({ ...ok, failed: true })).toBe(false);
  });

  it("refuses an empty path, which is the machine's roots rather than a directory", () => {
    expect(folderPickable({ ...ok, path: "" })).toBe(false);
    expect(folderPickable({ ...ok, path: "   " })).toBe(false);
  });
});

describe("isDirtyRefusal", () => {
  it("rewords this machine's 409, which is a dirty checkout", () => {
    expect(isDirtyRefusal(409, undefined)).toBe(true);
    expect(isDirtyRefusal(409, "")).toBe(true);
    expect(isDirtyRefusal(409, "self")).toBe(true);
  });

  it("leaves another machine's 409 alone, because there it means that machine is away", () => {
    expect(isDirtyRefusal(409, "desktop-abc")).toBe(false);
  });

  it("leaves every other status alone", () => {
    for (const status of [400, 403, 500, 504]) {
      expect(isDirtyRefusal(status, undefined)).toBe(false);
      expect(isDirtyRefusal(status, "desktop-abc")).toBe(false);
    }
  });
});
