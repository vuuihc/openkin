/**
 * Role presets: a named prompt prefix you can drop into a draft with one pick.
 *
 * A role is a saved instruction ("review as a security engineer", "write the
 * commit message in the imperative"), not a run setting. Picking one inserts
 * its text at the top of the draft and nothing else changes, so whatever the
 * agent is told is exactly what the transcript shows — there is no hidden
 * channel and no state to fall out of sync with the text the user can edit.
 *
 * The list lives in one settings key (`agent_roles`) so every device pointed
 * at the same daemon sees the same roles. The format is a JSON array; a
 * hand-edited key that fails to parse degrades to "no roles" rather than
 * breaking the composer.
 */
export type AgentRole = {
  /** Stable across renames; the editor's key and the picker's value. */
  id: string;
  name: string;
  /** The text inserted at the top of the draft. */
  prompt: string;
};

export const AGENT_ROLE_NAME_MAX = 60;
export const AGENT_ROLE_PROMPT_MAX = 32_768;
export const AGENT_ROLES_MAX = 50;

/**
 * The window event a settings save announces.
 *
 * The session host reads the roles once and stays mounted across routes, so a
 * role written on the settings page would otherwise be invisible to the
 * composer's `/` menu until a reload. The save names itself; `useAgentRoles`
 * reads again.
 */
export const AGENT_ROLES_CHANGED_EVENT = "kin:roles-changed";

/** The blank line that separates the role's text from the user's own words. */
const ROLE_GAP = "\n\n";

function clamp(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

/**
 * A slug good enough to key a row by when the stored entry has no id.
 *
 * Ids are written by `serializeAgentRoles`, so this only covers a key that was
 * typed by hand. It must still be stable across reads, or an editor's row
 * would lose focus every time the list is re-parsed.
 */
function fallbackId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "role";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Parse the stored settings value. Never throws: bad input is no roles. */
export function parseAgentRoles(raw: string | null | undefined): AgentRole[] {
  if (!raw || !raw.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const roles: AgentRole[] = [];
  const taken = new Set<string>();
  for (const item of data) {
    if (roles.length >= AGENT_ROLES_MAX) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? clamp(row.name.trim(), AGENT_ROLE_NAME_MAX) : "";
    const prompt = typeof row.prompt === "string" ? clamp(row.prompt, AGENT_ROLE_PROMPT_MAX) : "";
    // A role with no text would insert nothing, and a role with no name cannot
    // be chosen from a list. Either half missing is not a role.
    if (!name || !prompt.trim()) continue;
    let id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || taken.has(id)) id = fallbackId(name, taken);
    taken.add(id);
    roles.push({ id, name, prompt });
  }
  return roles;
}

/**
 * The settings value for a list. Pretty-printed: the key is human-editable.
 *
 * A half-written row — a name with no text, or the reverse — is dropped here
 * rather than saved, so what is stored is what the list shows. Persisting it
 * would leave a role that inserts nothing and reappears on no screen.
 */
export function serializeAgentRoles(roles: readonly AgentRole[]): string {
  return JSON.stringify(
    roles
      .map((role) => ({
        id: role.id,
        name: clamp(role.name.trim(), AGENT_ROLE_NAME_MAX),
        prompt: clamp(role.prompt, AGENT_ROLE_PROMPT_MAX),
      }))
      .filter((role) => role.name && role.prompt.trim()),
    null,
    2,
  );
}

/** A fresh id for a role being created, unique within `roles`. */
export function newAgentRoleId(roles: readonly AgentRole[]): string {
  return fallbackId("role", new Set(roles.map((role) => role.id)));
}

/** The role's text, trimmed; empty roles are filtered at parse time. */
function roleText(role: AgentRole): string {
  return role.prompt.trim();
}

/**
 * How much of `rest` is the seam between the role and the user's own words.
 *
 * Null when the role's text runs straight on into something else: a draft
 * like "Review as a security engineer. Edited." is the user's sentence now,
 * and treating its opening words as removable would delete an edit. A seam is
 * the end of the draft, or whitespace containing at least one line break —
 * which is exactly what `insertRole` writes and what a user keeps when they
 * tidy the spacing.
 */
function roleSeam(rest: string): number | null {
  if (!rest.trim()) return rest.length;
  const match = rest.match(/^[ \t]*\n[ \t\n]*/);
  return match ? match[0].length : null;
}

/** True when the draft opens with this role's text, as its own paragraph. */
export function hasRole(draft: string, role: AgentRole): boolean {
  const text = roleText(role);
  if (!text) return false;
  const head = draft.replace(/^\s+/, "");
  if (!head.startsWith(text)) return false;
  return roleSeam(head.slice(text.length)) !== null;
}

/**
 * Put the role's text at the top of the draft, followed by a blank line.
 *
 * Idempotent: a draft that already opens with the role is returned unchanged,
 * so picking the same role twice never doubles it.
 */
export function insertRole(draft: string, role: AgentRole): string {
  const text = roleText(role);
  if (!text || hasRole(draft, role)) return draft;
  const rest = draft.replace(/^\s+/, "");
  return rest ? `${text}${ROLE_GAP}${rest}` : text;
}

/**
 * Remove one leading occurrence of the role's text and the break after it.
 *
 * A draft the user has edited past the point of matching is returned
 * unchanged — removing text that is no longer the role's would delete the
 * user's own words.
 */
export function removeRole(draft: string, role: AgentRole): string {
  const text = roleText(role);
  if (!text) return draft;
  const head = draft.replace(/^\s+/, "");
  if (!head.startsWith(text)) return draft;
  const rest = head.slice(text.length);
  const seam = roleSeam(rest);
  if (seam === null) return draft;
  const tail = rest.slice(seam);
  return tail.trim() ? tail : "";
}

/** The role whose text opens the draft, or null when it opens with none. */
export function appliedRole(draft: string, roles: readonly AgentRole[]): AgentRole | null {
  for (const role of roles) {
    if (hasRole(draft, role)) return role;
  }
  return null;
}

/**
 * The roles whose name or prompt text contains `query`, in list order.
 *
 * The prompt is searched as well as the name: the reader remembers "the
 * security one" more often than what they called it. An empty query is every
 * role, not none — the menu's first frame lists the whole list.
 */
export function filterRoles(roles: readonly AgentRole[], query: string): AgentRole[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return roles.slice();
  return roles.filter(
    (role) =>
      role.name.toLowerCase().includes(needle) || role.prompt.toLowerCase().includes(needle),
  );
}

/**
 * Make `roleId` the draft's role — the one the picker names.
 *
 * A draft carries one role, not a stack: every known role's text comes out
 * first, then the chosen one goes in, so switching roles never leaves the
 * previous instruction behind. Passing null (or an id the list no longer has)
 * just clears. Removal is best-effort by design: a role the user has edited
 * into their own sentence stays where it is, because deleting it would delete
 * their words.
 */
export function selectRole(
  draft: string,
  roles: readonly AgentRole[],
  roleId: string | null | undefined,
): string {
  let next = draft;
  for (const role of roles) next = removeRole(next, role);
  const chosen = roleId ? roles.find((role) => role.id === roleId) : undefined;
  return chosen ? insertRole(next, chosen) : next;
}
