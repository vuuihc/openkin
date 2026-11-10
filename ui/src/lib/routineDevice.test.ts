import { describe, expect, it } from "vitest";
import type { Machine } from "./devices";
import {
  machineForRoutineDevice,
  resolveRoutineDevice,
  routineDeviceForBadge,
  routineDeviceForProject,
  THIS_MACHINE,
} from "./routineDevice";

function machine(id: string, over: Partial<Machine> = {}): Machine {
  return {
    id,
    label: id,
    isSelf: false,
    online: true,
    roots: [],
    agents: [],
    ...over,
  };
}

const SELF = machine("desktop-hub", { isSelf: true, label: "Hub" });
const LAPTOP = machine("device-laptop", { label: "Laptop" });
const STUDIO = machine("device-studio", { label: "Studio", online: false });

describe("resolveRoutineDevice", () => {
  it("keeps a remembered machine while it still exists", () => {
    expect(resolveRoutineDevice([SELF, LAPTOP, STUDIO], LAPTOP.id)).toBe(LAPTOP.id);
  });

  it("keeps an explicit choice of this machine", () => {
    // "self" has to survive as a choice: without the sentinel, choosing this
    // machine would be indistinguishable from never having chosen, and the page
    // would drift back to a laptop on the next open.
    expect(resolveRoutineDevice([SELF, LAPTOP], THIS_MACHINE)).toBe(THIS_MACHINE);
  });

  it("does not resurrect a machine that was revoked", () => {
    expect(resolveRoutineDevice([SELF, LAPTOP], "device-gone")).toBe(LAPTOP.id);
  });

  it("opens on another machine when nothing is remembered", () => {
    // On a phone this machine is the Hub, which holds no routines. Opening
    // there is the empty page the machine selection exists to fix.
    expect(resolveRoutineDevice([SELF, LAPTOP], "")).toBe(LAPTOP.id);
  });

  it("prefers a machine that is online", () => {
    expect(resolveRoutineDevice([SELF, STUDIO, LAPTOP], "")).toBe(LAPTOP.id);
    expect(resolveRoutineDevice([SELF, STUDIO], "")).toBe(STUDIO.id);
  });

  it("opens on this machine when it is the only one", () => {
    expect(resolveRoutineDevice([SELF], "")).toBe(THIS_MACHINE);
  });
});

describe("routineDeviceForProject", () => {
  const WORK_LAPTOP = machine("device-laptop", { roots: ["/Users/owner/work"] });
  const ELSEWHERE = machine("device-elsewhere", { roots: ["/srv/other"] });
  const ALSO_WORK = machine("device-second", { roots: ["/Users/owner/work"] });

  it("picks the machine whose roots contain the project folder", () => {
    // The project is a Hub-side record keyed by a folder; the machine that
    // reports that folder is the only one whose store can hold its routines.
    expect(
      routineDeviceForProject([SELF, ELSEWHERE, WORK_LAPTOP], "/Users/owner/work/app", ""),
    ).toBe(WORK_LAPTOP.id);
  });

  it("does not mistake a shared prefix for the same folder", () => {
    const sibling = machine("device-sibling", { roots: ["/Users/owner/workshop"] });
    expect(routineDeviceForProject([SELF, sibling], "/Users/owner/work", "")).toBe("");
  });

  it("keeps the Routines page choice when several machines report the folder", () => {
    // Two machines can work in the same path. The page the person just used is
    // the one they mean, not whichever happened to sort first.
    expect(
      routineDeviceForProject([SELF, WORK_LAPTOP, ALSO_WORK], "/Users/owner/work", ALSO_WORK.id),
    ).toBe(ALSO_WORK.id);
  });

  it("prefers an online owner, then list order", () => {
    const offline = machine("device-offline", {
      roots: ["/Users/owner/work"],
      online: false,
    });
    expect(routineDeviceForProject([SELF, offline, ALSO_WORK], "/Users/owner/work", "")).toBe(
      ALSO_WORK.id,
    );
    expect(routineDeviceForProject([SELF, offline], "/Users/owner/work", "")).toBe(offline.id);
  });

  it("falls back to this machine when no other machine names the folder", () => {
    // A console with no nodes is a desktop attached to its own daemon, and a
    // project created there by path is a local record.
    expect(routineDeviceForProject([SELF, ELSEWHERE], "/Users/owner/work", "")).toBe("");
    expect(routineDeviceForProject([SELF], "/Users/owner/work", "")).toBe("");
  });

  it("answers this machine for a project with no folder", () => {
    // Nothing to look up, so nothing from another machine's store either.
    expect(routineDeviceForProject([SELF, WORK_LAPTOP], "", WORK_LAPTOP.id)).toBe("");
  });

  it("ignores roots reported by this machine itself", () => {
    // machineList never gives the self record roots; even if a fixture did,
    // "this machine" is spelled empty, not by its id.
    const selfWithRoots = machine("desktop-hub", {
      isSelf: true,
      roots: ["/Users/owner/work"],
    });
    expect(routineDeviceForProject([selfWithRoots], "/Users/owner/work", "")).toBe("");
  });
});

describe("routineDeviceForBadge", () => {
  it("waits for a list that has not arrived", () => {
    // Counting this machine first and the chosen one a moment later would make
    // the badge flicker through a number that belongs to no machine the reader
    // is looking at.
    expect(routineDeviceForBadge([SELF, LAPTOP], "", true, false)).toBeNull();
  });

  it("counts the machine the page would open on", () => {
    expect(routineDeviceForBadge([SELF, LAPTOP], "", false, false)).toBe(LAPTOP.id);
    // A remembered machine that was revoked is not a choice, exactly as on the
    // page.
    expect(routineDeviceForBadge([SELF, LAPTOP], STUDIO.id, false, false)).toBe(LAPTOP.id);
  });

  it("keeps a remembered machine when the list cannot be read", () => {
    // The page keeps the saved choice on a failed read; a badge that fell back
    // to this machine would report a confident zero from the Hub's empty store.
    expect(routineDeviceForBadge([], LAPTOP.id, false, true)).toBe(LAPTOP.id);
  });

  it("counts this machine when it is the only one", () => {
    expect(routineDeviceForBadge([SELF], "", false, false)).toBe(THIS_MACHINE);
  });
});

describe("machineForRoutineDevice", () => {
  it("reads this console's own ids as this machine", () => {
    for (const id of ["", THIS_MACHINE, SELF.id]) {
      // The daemon knows three spellings of "this machine"; the page may hold
      // any of them, and all three name the self record.
      if (id === SELF.id) {
        expect(machineForRoutineDevice([SELF, LAPTOP], id)?.id).toBe(SELF.id);
        continue;
      }
      expect(machineForRoutineDevice([SELF, LAPTOP], id)?.isSelf).toBe(true);
    }
  });

  it("finds another machine by id", () => {
    expect(machineForRoutineDevice([SELF, LAPTOP], LAPTOP.id)?.label).toBe("Laptop");
  });

  it("answers nothing for a machine that is not in the list", () => {
    expect(machineForRoutineDevice([SELF], "device-gone")).toBeUndefined();
  });
});
