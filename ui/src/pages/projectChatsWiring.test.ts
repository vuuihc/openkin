import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The project row's seams, guarded where a unit cannot reach.
 *
 * KIN-CONTRACT-001 retired the project cover (`/projects/:id`), so the wiring
 * this file used to pin on that page now lives on the conversation list's
 * project row: the lazy work-instructions read, the two editors and their
 * version checks, and the absence of a second conversation list. The DOM
 * suites (`SessionList.projectFace.dom.test.tsx`,
 * `ProjectSummaryEditor.dom.test.tsx`, `ProjectRootsEditor.dom.test.tsx`) hold
 * what the reader sees; this file holds the structure a DOM test cannot name.
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting the
 * list needs a daemon and a machine list.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string) => readFileSync(join(UI, "src", path), "utf8");
const LIST = source("components/sessions/SessionList.tsx");
const SUMMARY = source("components/sessions/ProjectSummaryEditor.tsx");
const ROOTS = source("components/sessions/ProjectRootsEditor.tsx");

describe("the project row's data wiring (KIN-CONTRACT-001)", () => {
  it("has no project cover left to carry a second copy of the list", () => {
    // The retired page is the surface that used to own this wiring. Its
    // absence is the deletion, and `scripts/removed-surfaces.txt` keeps it
    // from coming back through a merge.
    expect(existsSync(join(UI, "src/pages/ProjectDetailPage.tsx"))).toBe(false);
    for (const gone of [
      "components/project/ProjectOnePager.tsx",
      "components/project/ProjectInstructionsBlock.tsx",
      "components/project/ProjectRootsBlock.tsx",
      "components/project/Heatmap.tsx",
      "design/heat.ts",
    ]) {
      expect(existsSync(join(UI, "src", gone)), gone).toBe(false);
    }
  });

  it("reads the work instructions only when the project row is expanded", () => {
    // Reading is lazy: a collapsed bucket issues no One-Pager read, and the
    // bucket header owns the condition (the block itself is not mounted).
    expect(LIST).toContain("if (collapsed || !instructionsProjectId) return;");
    expect(LIST).toContain("onReadInstructions(instructionsProjectId)");
  });

  it("keeps a cached answer painting and drops a read a newer one replaced", () => {
    // TASTE 15: a refresh paints the cached text instead of a skeleton, and a
    // late answer for a superseded read must not overwrite the newer one.
    expect(LIST).toContain("loaded: cached?.loaded ?? false,");
    expect(LIST).toContain("markdown: cached?.markdown ?? \"\",");
    expect(LIST).toContain(
      "if (instructionsGeneration.current.get(projectId) !== generation) return;",
    );
  });

  it("treats a missing ONE_PAGER.md as an empty section, not a failed read", () => {
    expect(LIST).toContain("error instanceof ApiError && error.status === 404");
    expect(LIST).not.toContain("Promise.all([getProject(id), getOnePager(id)])");
  });

  it("saves the summary against the version it read, and composes on a conflict", () => {
    expect(SUMMARY).toContain("from.updatedAt || undefined");
    expect(SUMMARY).toContain("setBase({ markdown: onePager.markdown, updatedAt: onePager.updated_at })");
    // The overwrite keeps the sections this editor does not own.
    expect(SUMMARY).toContain(
      "setBase({ markdown: conflict.markdown, updatedAt: conflict.updated_at })",
    );
    expect(SUMMARY).toContain('setSaveError(tr("projects.conflict"))');
  });

  it("disables both editors' writes while the machine is disconnected", () => {
    expect(SUMMARY).toContain("if (loaded && !saving && !offline && !conflict) void save(draft, base);");
    expect(SUMMARY).toContain("disabled={!loaded || saving || offline}");
    expect(ROOTS).toContain("const locked = offline || forbidden || gone;");
    expect(ROOTS).toContain("if (!saving && !locked) void save();");
  });

  it("offers one new-chat target per project row, not a second conversation list", () => {
    expect(LIST).toContain('tr("nav.newSessionIn", { project: bucket.label })');
    expect(LIST).not.toContain("ProjectChatsPanel");
    expect(LIST).not.toContain("ProjectTabStrip");
    expect(LIST).not.toContain("PROJECT_TABS");
    expect(LIST).not.toContain('role="tablist"');
  });

  it("narrows the one list instead of leaving it for a project page", () => {
    // The heading's destination is the same list with `?project=`; the cover
    // path survives only as the redirect `App.tsx` owns.
    expect(LIST).toContain("listStateQuery(params, { project: known.id })");
    expect(LIST).not.toContain("`/projects/${known.id}");
    expect(LIST).not.toContain("ensureProject(");
  });
});
