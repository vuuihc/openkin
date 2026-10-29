import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The project screen's conversation list, guarded where no unit can reach.
 *
 * `projectChats.test.ts` holds the row model, the two-feed loader and the tab
 * rule; what is left is the seam between the page and that loader, and the two
 * routes a row can open. Each of these fails quietly on its own: the tab
 * renders, the list looks plausible, and it is simply asking the wrong question
 * or opening the wrong page.
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting this page
 * needs a daemon, a machine list and a router.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/ProjectDetailPage.tsx"), "utf8");

describe("the project screen's conversations", () => {
  it("asks the project's own task feed through the loader", () => {
    // The endpoint exists and no page called it before this slice; a refactor
    // that stops asking would leave the tab showing only imported sessions.
    expect(SOURCE).toContain("loadProjectChats({");
    expect(SOURCE).toContain("tasks: () => listProjectTasks(projectId, 50)");
  });

  it("asks for imported sessions once per project root", () => {
    // Imported sessions are filtered by exact cwd, and a project may hold more
    // than one root; asking for one root would silently drop the others.
    expect(SOURCE).toContain("sessions: (root) => listAgentSessions({ cwd: root, limit: 50 })");
    expect(SOURCE).toContain("roots: projectRoots(project)");
  });

  it("drops a read that a newer one has replaced", () => {
    // The page outlives a route change; without this a slower read for the
    // previous project would land on the new project's screen.
    expect(SOURCE).toContain("isCurrent: () => gen === chatsRequest.current");
    expect(SOURCE).toContain("if (!outcome) return;");
  });

  it("always clears the loading flag it set", () => {
    // The loader reports feed failures as values, but a shape it cannot read
    // still throws. The flag belongs to the newest read and is cleared in a
    // finally, so no path leaves the tab spinning.
    expect(SOURCE).toContain("} finally {");
    expect(SOURCE).toContain("if (gen === chatsRequest.current) setChatsLoading(false);");
    expect(SOURCE).toContain('setChatsError(tr("projects.loadFailed"));');
  });

  it("shows rows only for the project they were read for", () => {
    expect(SOURCE).toContain("const [chatsFor, setChatsFor] = useState<string | null>(null)");
    expect(SOURCE).toContain("setChatsFor(outcome.projectId)");
    expect(SOURCE).toContain("rows={chatsFor === project.id ? chatRows : []}");
    expect(SOURCE).toContain("loading={chatsLoading || chatsFor !== project.id}");
  });

  it("keeps the previous list on screen while a reload runs", () => {
    // The loading branch is a skeleton only when there is nothing to keep; a
    // tab switch must not blank a list that is already known.
    expect(SOURCE).toContain("loading && rows.length === 0");
    expect(SOURCE).toContain("loading && rows.length > 0");
  });

  it("reads and writes the tab through the URL rule", () => {
    expect(SOURCE).toContain('normalizeProjectTab(params.get("tab"))');
    expect(SOURCE).toContain('p.set("tab", next)');
    // Overview is the default, so it leaves no parameter behind -- on arrival
    // as well as on click.
    expect(SOURCE).toContain('if (raw === null || raw === "chats") return;');
    expect(SOURCE).toContain('next.delete("tab")');
    expect(SOURCE).toContain('p.delete("tab")');
  });

  it("opens a task as a task and an imported session as a session", () => {
    expect(SOURCE).toContain("`/tasks/${encodeURIComponent(row.task.id)}`");
    expect(SOURCE).toContain("`/agent-sessions/${encodeURIComponent(row.session.id)}`");
  });

  it("offers a new chat inside the project's first root", () => {
    // The new-chat page already reads `?cwd=`; a project with no root gets no
    // button, because a chat started from it would not be in the project. The
    // root is trimmed by the same helper the loader uses, so the chat lands in
    // the project the button belongs to.
    expect(SOURCE).toContain("`/new?cwd=${encodeURIComponent(root)}`");
    expect(SOURCE).toContain("root={projectRoots(project)[0] ?? \"\"}");
  });

  it("announces the error and the partial list", () => {
    // Both are async outcomes the reader did not ask for; without a live
    // region a screen reader stays silent while the list changes underneath.
    expect(SOURCE).toContain('role="alert"');
    expect(SOURCE).toContain('role="status"');
  });

  it("renders one panel per tab and mounts only the selected one", () => {
    expect(SOURCE).toContain('role="tabpanel"');
    expect(SOURCE).toContain('id="project-panel-overview"');
    expect(SOURCE).toContain('id="project-panel-chats"');
    expect(SOURCE).toContain('{tab === "chats" && (');
    // The one-pager edit controls belong to the overview; leaving them above a
    // chats list would offer a Save for a form that is not on screen.
    expect(SOURCE).toContain('{tab === "overview" &&');
    // A tab may only point at a panel that is mounted; the unselected panel is
    // not, so no tab advertises one.
    expect(SOURCE).not.toContain("aria-controls");
  });
});
