import type { ReactNode } from "react";
import type { PanelId } from "../lib/panels";
import type { PlaceId } from "../lib/places";
import {
  IconAgents,
  IconArtifacts,
  IconExternal,
  IconFile,
  IconInbox,
  IconPlus,
  IconPullRequest,
  IconRoutines,
  IconSessions,
  IconSettings,
  IconTasks,
  IconTerminal,
  type IconProps,
} from "./icons";

/**
 * One icon per place, and one per panel.
 *
 * Both maps are `Record`s over the id unions rather than lookups with a fallback,
 * which makes the icon the *second* thing a new place or panel has to have: the
 * compiler refuses the module until the row exists, so a new panel cannot ship as
 * a grey question mark nobody notices. That is the same trade `PANEL_IDS` makes
 * for the panel table, one layer out.
 *
 * They hold the *components*, not rendered nodes, so a surface still chooses the
 * size it draws at — the sidebar's 15px footer rows and the palette's 16px list
 * rows are the same glyph at two sizes rather than two glyphs. Chrome the tables
 * do not decide (size, and which drawing a compact surface prefers) stays with the
 * surface, which is why the phone's tab bar draws its own inbox and settings.
 *
 * Icons live here rather than in `panels.ts` / `places.ts` so those stay data
 * modules the DOM-free tests can import — the same reason the panel table holds
 * no icon.
 */

export const PLACE_ICONS: Record<PlaceId, (p: IconProps) => ReactNode> = {
  new: IconPlus,
  sessions: IconSessions,
  tasks: IconTasks,
  inbox: IconInbox,
  artifacts: IconArtifacts,
  routines: IconRoutines,
  agents: IconAgents,
  settings: IconSettings,
};

export const PANEL_ICONS: Record<PanelId, (p: IconProps) => ReactNode> = {
  // The workspace panel is the file tree and the diff; the PR panel is the pull
  // request. Both are things the session owns, which is what they are drawn as.
  files: IconFile,
  pr: IconPullRequest,
  // Publishing writes to the Hub, which is the one panel whose subject is
  // somewhere else.
  publish: IconExternal,
  terminal: IconTerminal,
};
