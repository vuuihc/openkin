import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The composer's `/` menu lists saved roles, which live in settings — a
 * different route from the session that shows the menu.
 *
 * `agentRoles.test.ts` holds the filter and `Composer.slash.dom.test.tsx` holds
 * the menu. What is left is the wiring that puts a role list in front of the
 * composer: one read for the whole session host rather than one per live pane,
 * threaded down to the composer, and a re-read announced by the settings save.
 *
 * Source rather than DOM: mounting the session host needs a daemon, a
 * websocket, a router and a task list.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const HOST = readFileSync(join(UI, "src/pages/TaskSessionHost.tsx"), "utf8");
const DETAIL = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");
const SESSION = readFileSync(join(UI, "src/pages/AgentSessionDetailPage.tsx"), "utf8");
const NEW_CHAT = readFileSync(join(UI, "src/pages/NewChatPage.tsx"), "utf8");
const SETTINGS = readFileSync(join(UI, "src/pages/SettingsPage.tsx"), "utf8");

describe("the composer's prompt shortcuts", () => {
  it("reads the roles once for every pane the host keeps alive", () => {
    // The host can hold eight panes; a read per pane would be eight settings
    // fetches at app start for one list that only changes on another route.
    expect(HOST.match(/useAgentRoles\(\)/g)).toHaveLength(1);
    expect(HOST).toContain("const agentRoles = useAgentRoles();");
    expect(HOST).toContain("agentRoles={agentRoles}");
    expect(DETAIL).not.toContain("useAgentRoles(");
  });

  it("threads the list from the page into the composer", () => {
    expect(DETAIL).toContain('import type { AgentRole } from "../lib/agentRoles";');
    expect(DETAIL).toContain("agentRoles?: AgentRole[] | null;");
    expect(DETAIL).toContain("agentRoles = [],");
    expect(DETAIL).toContain("roles={agentRoles}");
  });

  it("gives the imported session's continue box the same list", () => {
    // The same composer is the continue box on a session imported from a CLI.
    // Without the list its `/` menu would claim there are no saved roles.
    expect(SESSION).toContain("const agentRoles = useAgentRoles();");
    expect(SESSION).toContain("roles={agentRoles}");
  });

  it("gives the new-chat composer the list the page already reads", () => {
    // The page reads the roles for its own Role row; the composer beside it
    // must not render "no saved roles" over the same list.
    expect(NEW_CHAT).toContain("const agentRoles = useAgentRoles();");
    expect(NEW_CHAT).toContain("roles={agentRoles}");
  });

  it("re-reads when a save announces itself, after the write", () => {
    expect(SETTINGS).toContain("AGENT_ROLES_CHANGED_EVENT,");
    expect(SETTINGS).toContain("window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));");
    // After the write, not before: an announcement that raced the save would
    // re-read the list this save is replacing.
    expect(
      SETTINGS.indexOf("window.dispatchEvent(new Event(AGENT_ROLES_CHANGED_EVENT));"),
    ).toBeGreaterThan(SETTINGS.indexOf("const s = await updateSettings(body);"));
  });
});
