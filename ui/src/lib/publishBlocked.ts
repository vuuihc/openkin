import { t } from "../i18n";

/**
 * The publish refusals the console has a sentence of its own for.
 *
 * The vocabulary is the machine's (internal/github/publish.go) and it is closed,
 * so this list is all of it. Each code gets one line in the person's own
 * language, drawn above the machine's own sentence — that sentence carries the
 * branch and the file names, which a line written here cannot know.
 */
export const BLOCKED_CODES = [
  "not_a_checkout",
  "no_github_remote",
  "detached_head",
  "default_branch",
  "uncommitted_changes",
  "no_gh",
] as const;

/**
 * The headline for a refusal, or "" when there is nothing honest to write.
 *
 * Empty for a code this console does not know: a machine newer than the console
 * can refuse for a reason that has no line here yet, and showing the machine's
 * own sentence beats inventing a meaning for a word nobody defined.
 */
export function blockedHeadline(code: string): string {
  if (!code || !(BLOCKED_CODES as readonly string[]).includes(code)) return "";
  const path = `publish.blockedWhy.${code}`;
  const line = t(path);
  // A key missing from the catalog comes back as its own path, which is a worse
  // thing to put in front of a person than the sentence underneath it.
  return line === path ? "" : line;
}

/** The code the Hub puts on a write it will not do for a session running here. */
const SESSION_RUNS_HERE = "session_runs_here";

/**
 * Is this the conflict that has a line of its own?
 *
 * Both publish routes can answer 409 twice over: for a session running on the
 * daemon the console is talking to, and for a workspace on that machine the Hub
 * cannot place. Only the first may be drawn as "there is nothing to publish from
 * here" — telling somebody their session runs on this machine when it runs on
 * another is worse than repeating the daemon's own sentence at them.
 */
export function isSessionRunsHere(err: { status: number; body?: unknown }): boolean {
  if (err.status !== 409) return false;
  const code = (err.body as { code?: unknown } | undefined)?.code;
  return code === SESSION_RUNS_HERE;
}
