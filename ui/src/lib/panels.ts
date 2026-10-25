/**
 * The full-bleed surfaces a session can open over itself, as one table.
 *
 * They used to be three unrelated things: a `useState<Overlay>` in the task page,
 * a `terminalOpen` in the shell, and — for every one of them — a hand-copied
 * `absolute inset-0 z-40` wrapper with its own idea of when it was allowed to
 * appear. "Which one is open" therefore had two writers that did not know about
 * each other, and "what a surface looks like" had five copies. One table makes
 * the first structural, and one container (`PanelSurface`) makes the second
 * single.
 *
 * The table holds data, not presentation: no icon, no component. Both would drag
 * the component tree (and, for the terminal, xterm) into this module, which is
 * the module the no-DOM tests import — see the P2 plan's test strategy. The
 * guards that matter here are all answerable from data: ids are unique, every
 * `titleKey` exists in both locales, and the command palette can be generated
 * from the same list instead of a second hand-written one.
 */
/**
 * The ids, as a value.
 *
 * The union is derived from this list rather than written beside it, because a
 * union is erased at runtime: a fourth panel added to a hand-written union and
 * forgotten in `PANELS` would compile, ship, and throw in the render path. Here
 * the only way to add an id is to add it to the list, and the list is what the
 * test walks.
 */
export const PANEL_IDS = ["files", "pr", "publish", "terminal"] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/**
 * The view key for the panels that belong to no session.
 *
 * There is one such panel — the terminal — and it is the shell's because it is
 * one instance whose directory follows the route, not one per session. Session
 * ids are never empty, so this key cannot collide with one.
 */
export const SHELL_VIEW = "";

/**
 * What the table needs to know about the place it is being asked about. Built by
 * the caller from whatever it already has, so the answer is a pure function of
 * it and can be tested without a DOM.
 */
export type PanelContext = {
  taskId: string | null;
  /** The session's checkout is on another machine, so publishing applies to it. */
  remote: boolean;
  /** This is the desktop shell, which is the only place a terminal can exist. */
  desktop: boolean;
};

export type PanelDescriptor = {
  id: PanelId;
  /** Locale key for the panel's title, and for whatever control opens it. */
  titleKey: string;
  /**
   * The keyboard shortcut, where one exists.
   *
   * It lives here rather than at the surface that draws it because it is a fact
   * about the panel: the palette's hint column and the key handler that acts on it
   * have to agree, and two literals are two chances to disagree. The handler still
   * matches the real event; this is what the row promises.
   */
  hint?: string;
  available(ctx: PanelContext): boolean;
};

export const PANELS: PanelDescriptor[] = [
  {
    // The workspace panel is about the session in front of you, so it is offered
    // for every session, including one whose checkout is elsewhere: that is what
    // its file tree shows.
    id: "files",
    titleKey: "workspace.title",
    available: (ctx) => ctx.taskId !== null,
  },
  {
    id: "pr",
    titleKey: "pr.title",
    available: (ctx) => ctx.taskId !== null,
  },
  {
    // Publishing writes to a repository the Hub holds, and it is only offered for
    // a session running on another machine — the one case where the write is the
    // local machine's to make. A button that could only ever be refused is worse
    // than no button, so the gate lives here rather than inside the sheet.
    id: "publish",
    titleKey: "publish.title",
    available: (ctx) => ctx.remote,
  },
  {
    // The terminal is a shell on the machine running the console, so it exists
    // only in the desktop shell. On the phone it would be a terminal for a
    // machine you are not holding.
    id: "terminal",
    titleKey: "terminal.title",
    hint: "Ctrl+`",
    available: (ctx) => ctx.desktop,
  },
];

export function panelById(id: PanelId): PanelDescriptor {
  const found = PANELS.find((p) => p.id === id);
  if (!found) {
    // Unreachable while `PANELS` covers `PANEL_IDS` — the test is what keeps it
    // that way; this is the backstop that turns a gap into a sentence rather
    // than `undefined.available is not a function`.
    throw new Error(`unknown panel: ${id}`);
  }
  return found;
}

export function isPanelAvailable(id: PanelId, ctx: PanelContext): boolean {
  return panelById(id).available(ctx);
}

/** The panels offered in this context, in table order. */
export function availablePanels(ctx: PanelContext): PanelDescriptor[] {
  return PANELS.filter((p) => p.available(ctx));
}

/**
 * The one panel that is open, and the view it belongs to.
 *
 * One value with one `view`, rather than a map of view to panel, because "at
 * most one surface" is the invariant this layer exists to hold and this is the
 * shape that cannot express anything else. A map can: `{session: "files",
 * shell: "terminal"}` is two surfaces, both at `z-40`, one of them under the
 * other with its close button unreachable — which is the bug.
 *
 * The `view` is what keeps switching sessions from carrying a panel across. A
 * session reads this only when the `view` is its own, so switching to another
 * session shows that session's panel (usually none) and switching back shows
 * this one again — the panel is remembered for the place it was opened, which is
 * what "switching tabs does not lose state" asks for.
 */
export type OpenPanel = { view: string; id: PanelId } | null;

/** What `view` is showing, if the open panel belongs to it. */
export function panelForView(open: OpenPanel, view: string): PanelId | null {
  return open && open.view === view ? open.id : null;
}

/**
 * What asking `view` for `id` does to the open panel.
 *
 * Asking for the one already open closes it; anything else replaces it,
 * whichever view it belonged to. So the terminal yields to the workspace panel
 * and the workspace panel yields to the terminal — one rule, both directions,
 * no preference between them to remember. What it gives up is the memory of the
 * panel it replaced; one surface is the point, and one memory is what that costs.
 */
export function nextOpenPanel(open: OpenPanel, view: string, id: PanelId): OpenPanel {
  const shown = panelForView(open, view);
  return shown === id ? null : { view, id };
}

/** Closing is only ever about the view in front; another view's panel is not yours to close. */
export function closeOpenPanel(open: OpenPanel, view: string): OpenPanel {
  return open && open.view === view ? null : open;
}

/**
 * The panel to render, given what is open and what is currently offered. A panel
 * that stops being available while it is open (the session moved to a machine
 * whose checkout the Hub holds, so the publish sheet no longer applies) closes
 * itself rather than rendering in a state it is not allowed to be in.
 */
export function resolvePanel(current: PanelId | null, ctx: PanelContext): PanelId | null {
  if (current === null) return null;
  return isPanelAvailable(current, ctx) ? current : null;
}
