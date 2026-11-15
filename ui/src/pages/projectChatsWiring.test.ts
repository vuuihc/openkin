import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The project cover's seams, guarded where a unit cannot reach.
 *
 * `projectChats.test.ts` holds the row model and the two-feed loader;
 * `ProjectDetailPage.dom.test.tsx` holds what the reader sees. What is left is
 * how the page wires them: which feed it asks, how many rows it keeps, where a
 * failing feed is allowed to write, and the two things the signed cover removed
 * (the conversation tab and routine creation on the cover).
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting this
 * page needs a daemon, a machine list and a router.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
// The page composes its sections; the seams below live in the page, the cover
// (keys and the offline notice) and the one-pager (the save body), so read the
// composition rather than one file.
const SOURCE = [
  "src/pages/ProjectDetailPage.tsx",
  "src/components/project/ProjectCover.tsx",
  "src/components/project/ProjectOnePager.tsx",
]
  .map((path) => readFileSync(join(UI, path), "utf8"))
  .join("\n");

describe("the project cover's data wiring (KIN-PROJECT-001)", () => {
  it("asks the project's own task feed through the loader", () => {
    expect(SOURCE).toContain("loadProjectChats({");
    expect(SOURCE).toContain("tasks: () => listProjectTasks(projectId, 50)");
  });

  it("asks for imported sessions once per project root", () => {
    // Imported sessions are filtered by exact cwd, and a project may hold more
    // than one root; asking for one root would silently drop the others.
    expect(SOURCE).toContain("sessions: (root) => listAgentSessions({ cwd: root, limit: 50 })");
    expect(SOURCE).toContain("roots: projectRoots(target)");
  });

  it("keeps one row — the newest — not a second conversation list", () => {
    expect(SOURCE).toContain("limit: 1,");
    expect(SOURCE).toContain("setLatest(outcome.rows[0] ?? null)");
    expect(SOURCE).not.toContain("ProjectChatsPanel");
    expect(SOURCE).not.toContain("ProjectTabStrip");
    expect(SOURCE).not.toContain("PROJECT_TABS");
    expect(SOURCE).not.toContain('role="tablist"');
  });

  it("writes the row only from a read that succeeded", () => {
    // A failed task feed returns `rows: []`; applying that would erase the last
    // conversation and its time. The clear is a successful empty read only.
    expect(SOURCE).toMatch(
      /if \(!outcome\.error\) \{[\s\S]{0,160}setLatest\(outcome\.rows\[0\] \?\? null\)/,
    );
    expect(SOURCE).toMatch(
      /if \(!outcome\.error\) \{[\s\S]{0,160}setLastImportAt\(outcome\.lastImportAt\)/,
    );
  });

  it("drops a read that a newer one has replaced", () => {
    // The page outlives a route change; without this a slower read for the
    // previous project would land on the new project's screen.
    expect(SOURCE).toContain("isCurrent: () => gen === activityRequest.current");
    expect(SOURCE).toContain("if (!outcome) return;");
  });

  it("always clears the loading flag it set", () => {
    expect(SOURCE).toContain("} finally {");
    expect(SOURCE).toContain("if (gen === activityRequest.current) setActivityLoading(false);");
    expect(SOURCE).toContain('setActivityError(tr("projects.activityFailed"));');
  });

  it("shows the activity row only for the project it was read for", () => {
    expect(SOURCE).toContain("const [activityFor, setActivityFor] = useState<string | null>(null)");
    expect(SOURCE).toContain("setActivityFor(outcome.projectId)");
    expect(SOURCE).toContain("activityFor === currentProject.id ? latest : null");
  });

  it("keeps the previous row when a reload fails", () => {
    // The DOM suite pins the behavior; this pins that the preservation is
    // structural — a replay of the last row, not a re-read that could be empty.
    expect(SOURCE).toContain(
      'setActivityError(outcome.error ? tr("projects.activityFailed") : null)',
    );
    expect(SOURCE).not.toMatch(/setActivityError[\s\S]{0,80}setLatest\(null\)/);
  });

  it("reads pulse into its own failure state, not the page's", () => {
    expect(SOURCE).toContain("getProjectPulse(id, PULSE_WINDOW_DAYS)");
    expect(SOURCE).toContain('setPulseError(tr("projects.overviewUnavailable"))');
    expect(SOURCE).toContain("pulseFor === currentProject.id ? pulse : null");
    // The page-level error is set by the project record read alone: a missing
    // One-Pager is a summary state, never "project not found".
    expect(SOURCE).toContain("setError({ message, notFound: false })");
    expect(SOURCE).toContain('setError({ message: tr("projects.notFound"), notFound: true })');
    expect(SOURCE).not.toContain("Promise.all([getProject(id), getOnePager(id)])");
  });

  it("reads the project record and the One-Pager independently", () => {
    expect(SOURCE).toContain("const p = await getProject(id)");
    expect(SOURCE).toContain("const op = await getOnePager(id)");
    expect(SOURCE).toContain("setOnePagerError");
    expect(SOURCE).toContain("e instanceof ApiError && e.status === 404");
  });

  it("keeps the routines block read-only and points at /routines", () => {
    expect(SOURCE).toContain("listRoutines({ limit: 100 }, routineDevice || undefined)");
    expect(SOURCE).toContain("`/routines?device=${encodeURIComponent(routineDevice)}`");
    expect(SOURCE).toContain("onGuardedLinkClick(");
    expect(SOURCE).toContain("routineDeviceForProject(");
    expect(SOURCE).not.toContain("createRoutine");
    expect(SOURCE).not.toContain("RoutineScheduleFields");
    expect(SOURCE).not.toContain("serializeRoutineRule");
  });

  it("composes the summary into Current Focus and saves against its version", () => {
    expect(SOURCE).toContain("setOnePagerFocus(base, body)");
    expect(SOURCE).toContain(
      "putOnePager(id, setOnePagerFocus(base, body), baseUpdatedAt || undefined)",
    );
    // A conflict composes on the other version, so choosing overwrite keeps
    // their sections that this editor does not own.
    expect(SOURCE).toContain("void saveSummary(conflict.markdown, conflict.updated_at, body)");
    // The base does not move under a reconnect; otherwise a concurrent edit on
    // another device would be overwritten without a 409.
    expect(SOURCE).toContain("setEditBase({ markdown, updatedAt })");
    expect(SOURCE).toContain("saveSummary(editBase.markdown, editBase.updatedAt, body)");
  });

  it("offers one new-chat target and no guess for a multi-root project", () => {
    expect(SOURCE).toContain("projectNewChatTarget(currentProject)");
    expect(SOURCE).not.toContain("`/new?cwd=${encodeURIComponent(root)}`");
  });

  it("lets offline show the last result and disables the writes", () => {
    expect(SOURCE).toContain('wsStatus === "disconnected"');
    expect(SOURCE).toContain('tr("projects.offlineSince"');
    expect(SOURCE).toContain("disabled={offline}");
    expect(SOURCE).toContain('tr("projects.newChatOffline")');
  });

  it("puts the reader back where they left the cover", () => {
    expect(SOURCE).toContain("writeProjectScroll(projectId, scrollTopRef.current)");
    expect(SOURCE).toContain("readProjectScroll(projectId)");
    // Restoring against a skeleton clamps the offset and forgets it. Wait for
    // the blocks that give the page its height.
    expect(SOURCE).toContain(
      "const contentReady = !pulseLoading && !routinesLoading && !activityLoading",
    );
    expect(SOURCE).toContain("if (!currentProject || loading || !contentReady) return;");
  });

  it("keeps the last cover for an offline visit, and forgets a deleted project", () => {
    expect(SOURCE).toContain("readProjectCover(id)");
    expect(SOURCE).toContain("writeProjectCover(currentProject.id, {");
    expect(SOURCE).toContain("clearProjectCover(id)");
  });

  it("binds Esc and ⌘Enter at the window, not only while the scroller has focus", () => {
    expect(SOURCE).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(SOURCE).toContain("event.metaKey || event.ctrlKey");
    expect(SOURCE).toContain("phonePush(navigate, location, newChatHref, {");
    expect(SOURCE).toContain('button.getAttribute("aria-label") === name');
  });
});
