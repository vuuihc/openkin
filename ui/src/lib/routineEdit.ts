/**
 * What an edit to a routine actually changes.
 *
 * The console could create, pause, resume and delete a routine, but every other
 * field was frozen at creation even though the daemon's PATCH accepts them all.
 * The form is the create form reused, so the patch has to be derived: PATCH is a
 * partial update and every field in it is written.
 *
 * Scheduling is the field that bites. Sending `recurrence` again makes the
 * daemon recompute `next_due_at` from the rule, which moves a routine whose
 * title was the only thing edited; and a rule carries the zone it was written
 * in, so re-sending an untouched rule from another machine rewrites the zone.
 * This module therefore compares the schedule the reader is looking at with the
 * one the daemon holds, and says nothing about it when they match.
 */
import type { PatchRoutineBody, Routine } from "../api/client";
import { normalizePermissionMode } from "./permissionMode";
import {
  localTimeZone,
  parseRoutineRule,
  ruleTimeZone,
  serializeRoutineRule,
  type RoutineRule,
} from "./routineRecurrence";

/** The form fields an edit can change, as the page holds them. */
export type RoutineForm = {
  title: string;
  prompt: string;
  cwd: string;
  agent: string;
  permissionMode: string;
  intervalSecs: number;
  rule: RoutineRule | null;
  /** The first/next run the form holds, in ms; read for intervals and one-offs. */
  nextRunMs: number | null;
  /**
   * The zone the rule's hour/minute are expressed in. Null = the browser's
   * (there is no stored rule); "" = the stored rule names none, which the
   * daemon reads as its own local zone; otherwise the stored zone's name.
   */
  ruleZone: string | null;
};

/** The form a routine opens with. */
export function routineForm(routine: Routine): RoutineForm {
  return {
    title: routine.title ?? "",
    prompt: routine.prompt,
    cwd: routine.cwd,
    agent: routine.agent ?? "",
    permissionMode: routine.permission_mode,
    intervalSecs: routine.interval_secs,
    rule: parseRoutineRule(routine.recurrence),
    nextRunMs: routine.next_due_at || null,
    ruleZone: ruleTimeZone(routine.recurrence),
  };
}

/**
 * The title a routine gets when the reader leaves the field blank: the prompt's
 * first 48 characters. Shared with create so an edit that clears the title and
 * a create that never set one produce the same row.
 */
export function routineTitle(title: string, prompt: string): string {
  const runes = Array.from(title.trim() || prompt.trim());
  return runes.length > 48 ? runes.slice(0, 48).join("") + "…" : runes.join("");
}

/**
 * A rule as a comparable string: the wall-clock meaning only, without the zone
 * it was written in and without the array order the days were picked in.
 */
function ruleShape(rule: RoutineRule): string {
  switch (rule.kind) {
    case "once":
      return "once";
    case "daily":
      return `daily ${rule.hour}:${rule.minute}`;
    case "weekdays":
      return `weekdays ${rule.hour}:${rule.minute}`;
    case "weekly":
      return `weekly ${rule.hour}:${rule.minute} ${[...rule.weekdays].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `monthly ${rule.hour}:${rule.minute} ${[...rule.days].sort((a, b) => a - b).join(",")}`;
  }
}

/**
 * The same wall-clock minute.
 *
 * The form's date-time control holds a minute; the daemon's instants carry
 * seconds (an interval routine's next run is jittered on purpose), so an exact
 * comparison would report every untouched schedule as changed and move it a few
 * seconds earlier on every save.
 */
function sameMinute(a: number, b: number): boolean {
  return Math.floor(a / 60_000) === Math.floor(b / 60_000);
}

function schedulePatch(
  routine: Routine,
  original: RoutineRule | null,
  form: RoutineForm,
  now: number,
): PatchRoutineBody {
  const nextRunMs = form.nextRunMs;
  // An empty next-run field means "as soon as possible" — create reads it the
  // same way, by leaving the instant out and letting the daemon default to now.
  // A patch has no such default, so the reader clearing the field has to say so
  // explicitly or the old instant would silently stay.
  const nextRun = nextRunMs ?? now;
  // A rule keeps the zone it was written in. Re-stamping the reader's zone
  // would reinterpret the wall clock it stores: a 09:00 rule written in
  // Asia/Shanghai edited from UTC would start firing at 09:00 UTC, and a
  // repeated rule has no single instant to convert. "" is a rule stored with
  // no zone, which the daemon fires on its own local clock; it stays zone-less.
  const zone = form.ruleZone ?? localTimeZone();
  if (form.rule) {
    if (original && ruleShape(original) === ruleShape(form.rule)) {
      // The same rule. Only a one-off has an instant the reader can re-time.
      if (form.rule.kind !== "once") return {};
      if (nextRunMs == null || sameMinute(nextRunMs, routine.next_due_at)) return {};
      return {
        recurrence: serializeRoutineRule(form.rule, nextRunMs, zone),
        next_due_at: nextRunMs,
      };
    }
    // A new rule: the daemon derives the next run from the rule itself, so the
    // form's next-run field is not sent — an instant the rule does not own
    // would contradict it.
    const recurrence = serializeRoutineRule(form.rule, nextRunMs, zone);
    return recurrence ? { recurrence } : {};
  }
  if (original || (routine.recurrence ?? "").trim()) {
    // The rule was cleared — or it is one this console cannot read, which the
    // form can only show as interval mode. "" is how the daemon is told to drop
    // it; leaving it in place would keep a routine that never fires.
    return { recurrence: "", interval_secs: form.intervalSecs, next_due_at: nextRun };
  }
  const patch: PatchRoutineBody = {};
  if (form.intervalSecs !== routine.interval_secs) patch.interval_secs = form.intervalSecs;
  if (!sameMinute(nextRun, routine.next_due_at)) patch.next_due_at = nextRun;
  return patch;
}

/**
 * The body to PATCH, or null when the form says what the daemon already has.
 *
 * Two comparisons are deliberately loose, both so that saving cannot change
 * something the reader did not touch. Permission modes compare after
 * normalisation: a stored mode this console does not know normalises to the
 * default on both sides. Times compare to the minute (see `sameMinute`).
 *
 * The title is never truncated or derived from a title someone else set — but
 * a blank field means what it means in create: use the prompt's first 48
 * characters. Sending "" instead would leave the daemon to call the
 * routine's runs "Routine", a different row from the one create makes.
 */
export function routinePatch(
  routine: Routine,
  form: RoutineForm,
  now: number = Date.now(),
): PatchRoutineBody | null {
  const patch: PatchRoutineBody = {};
  const typedTitle = form.title.trim();
  // Derived only when the reader emptied the field — the same fallback create
  // uses, so clearing a title and creating without one agree.
  const nextTitle = typedTitle || routineTitle("", form.prompt.trim());
  if (nextTitle !== (routine.title ?? "")) patch.title = nextTitle;
  const prompt = form.prompt.trim();
  if (prompt !== (routine.prompt ?? "").trim()) patch.prompt = prompt;
  const cwd = form.cwd.trim();
  if (cwd !== routine.cwd) patch.cwd = cwd;
  if ((form.agent ?? "") !== (routine.agent ?? "")) patch.agent = form.agent;
  if (
    normalizePermissionMode(form.permissionMode) !==
    normalizePermissionMode(routine.permission_mode)
  ) {
    patch.permission_mode = form.permissionMode;
  }
  Object.assign(patch, schedulePatch(routine, parseRoutineRule(routine.recurrence), form, now));
  return Object.keys(patch).length > 0 ? patch : null;
}
