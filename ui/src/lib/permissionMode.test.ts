// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getDraftPermissionMode,
  normalizePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
  PERMISSION_MODES,
  permissionModesForAgent,
  setDraftPermissionMode,
} from "./permissionMode";

/**
 * KIN-START-001 regression: one name per mode, one ladder per run.
 *
 * The card's bottom row shows the mode and the run settings pick it, so the
 * label table and the clamp both have to agree with what the machine will
 * actually accept.
 */
describe("the permission ladder (KIN-START-001)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("names each of the three modes once", () => {
    expect(PERMISSION_MODES).toEqual(["default", "accept_edits", "yolo"]);
    const keys = PERMISSION_MODES.map((mode) => PERMISSION_MODE_LABEL_KEY[mode]);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key.startsWith("permission.")).toBe(true);
  });

  it("reads the provider spellings as the three modes", () => {
    expect(normalizePermissionMode("acceptEdits")).toBe("accept_edits");
    expect(normalizePermissionMode("accept-edits")).toBe("accept_edits");
    expect(normalizePermissionMode("bypassPermissions")).toBe("yolo");
    expect(normalizePermissionMode("bypass")).toBe("yolo");
    expect(normalizePermissionMode(undefined)).toBe("default");
    expect(normalizePermissionMode("nonsense")).toBe("default");
  });

  it("offers only what the run advertises", () => {
    expect(
      permissionModesForAgent({ permission_modes: ["default", "accept_edits"] }, true),
    ).toEqual(["default", "accept_edits"]);
    expect(
      permissionModesForAgent({ permission_modes: ["default", "accept_edits"] }, false),
    ).toEqual(["default", "accept_edits"]);
    expect(permissionModesForAgent({ permission_modes: [] }, true)).toEqual(["default"]);
  });

  it("withholds yolo from a machine that did not advertise a ladder", () => {
    expect(permissionModesForAgent(undefined, true)).toEqual(PERMISSION_MODES);
    expect(permissionModesForAgent(undefined, false)).toEqual(["default", "accept_edits"]);
  });

  it("keeps the last chosen mode for the next draft", () => {
    expect(getDraftPermissionMode()).toBe("default");
    setDraftPermissionMode("accept_edits");
    expect(getDraftPermissionMode()).toBe("accept_edits");
  });
});
