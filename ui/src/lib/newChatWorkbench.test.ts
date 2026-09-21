import { describe, expect, it } from "vitest";
import { newChatControlGroups } from "./newChatWorkbench";

describe("newChatControlGroups", () => {
  it("keeps start/run controls before routing and workspace controls", () => {
    const groups = newChatControlGroups({ asRoutine: false });

    expect(groups.map((group) => group.id)).toEqual(["run", "route", "workspace"]);
    expect(groups[0].controls).toEqual(["permission", "routine"]);
    expect(groups[1].controls).toEqual(["hostModel", "dispatch"]);
    expect(groups[2].controls).toEqual(["cwd", "branch"]);
  });

  it("hides routing controls in routine mode while preserving workspace controls", () => {
    const groups = newChatControlGroups({ asRoutine: true });

    expect(groups.map((group) => group.id)).toEqual(["run", "workspace"]);
    expect(groups.flatMap((group) => group.controls)).toEqual([
      "permission",
      "routine",
      "cwd",
      "branch",
    ]);
  });
});
