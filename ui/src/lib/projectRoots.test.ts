import { describe, expect, it } from "vitest";
import {
  appendProjectRoot,
  makeProjectRootDefault,
  normalizeProjectRoots,
  removeProjectRoot,
} from "./projectRoots";

/**
 * KIN-PROJECT-002: the folder list is edited as a whole and saved as a whole,
 * so these are the rules the editor's draft obeys before it ever reaches the
 * daemon. `PATCH /api/projects/:id` replaces the list, which means a draft that
 * keeps a blank or a duplicate is a draft that writes one.
 */
describe("project roots (KIN-PROJECT-002)", () => {
  it("KIN-PROJECT-002 normalizeProjectRoots trims, drops blanks and duplicates, first occurrence wins", () => {
    const roots = normalizeProjectRoots([
      "  /work/alpha  ",
      "",
      "   ",
      "/work/alpha-config",
      "/work/alpha",
      "/work/alpha-config ",
    ]);

    // The first spelling of a folder owns its position; a later duplicate does
    // not move it and does not add a second row.
    expect(roots).toEqual(["/work/alpha", "/work/alpha-config"]);
  });

  it("KIN-PROJECT-002 makeProjectRootDefault moves the chosen root to the front and keeps the relative order", () => {
    const roots = ["/work/alpha", "/work/alpha-config", "/work/shared-lib"];

    expect(makeProjectRootDefault(roots, "/work/shared-lib")).toEqual([
      "/work/shared-lib",
      "/work/alpha",
      "/work/alpha-config",
    ]);
    // Choosing the root that is already first is a no-op, not a rotation.
    expect(makeProjectRootDefault(roots, "/work/alpha")).toEqual(roots);
    // A root that is not in the list cannot be made default by inventing it.
    expect(makeProjectRootDefault(roots, "/work/elsewhere")).toEqual(roots);
    // The input is not mutated: the caller's saved list is the source it may
    // have to compare against.
    expect(roots).toEqual(["/work/alpha", "/work/alpha-config", "/work/shared-lib"]);
  });

  it("KIN-PROJECT-002 removeProjectRoot on the only root yields an empty list, not a throw", () => {
    expect(removeProjectRoot(["/work/alpha"], "/work/alpha")).toEqual([]);
    expect(removeProjectRoot([], "/work/alpha")).toEqual([]);
    expect(removeProjectRoot(["/work/a", "/work/b"], "/work/ghost")).toEqual([
      "/work/a",
      "/work/b",
    ]);
  });

  it("KIN-PROJECT-002 appendProjectRoot reports a duplicate instead of adding a second row", () => {
    const roots = ["/work/alpha", "/work/alpha-config"];

    expect(appendProjectRoot(roots, "/work/shared-lib")).toEqual({
      roots: ["/work/alpha", "/work/alpha-config", "/work/shared-lib"],
      duplicate: false,
    });
    // A folder picked again — even with whitespace around it — is the same
    // folder, and the editor must say so instead of drawing it twice.
    expect(appendProjectRoot(roots, "  /work/alpha  ")).toEqual({
      roots,
      duplicate: true,
    });
    // A blank pick is not a folder; it changes nothing and is not a duplicate.
    expect(appendProjectRoot(roots, "   ")).toEqual({ roots, duplicate: false });
  });
});
