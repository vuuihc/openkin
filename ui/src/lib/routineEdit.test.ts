import { describe, expect, it } from "vitest";
import type { Routine } from "../api/client";
import { parseLocalDateTime, toLocalInputValue } from "../components/routine/RoutineScheduleFields";
import { routineForm, routinePatch, routineTitle } from "./routineEdit";
import { localTimeZone, serializeRoutineRule, type RoutineRule } from "./routineRecurrence";

const DAY = 86400;

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    cwd: "/work/project",
    agent: "kin",
    permission_mode: "default",
    prompt: "summarise the open issues",
    interval_secs: DAY,
    enabled: true,
    next_due_at: 1_700_000_000_000,
    consec_failures: 0,
    created_at: 1_600_000_000_000,
    title: "Open issues",
    missed_run_policy: "coalesce",
    lane: "",
    ...overrides,
  };
}

const daily = (hour = 9, minute = 0): RoutineRule => ({ kind: "daily", hour, minute });

/** The routine's own form, so a test only states what the reader changed. */
function form(r: Routine, changes: Partial<ReturnType<typeof routineForm>> = {}) {
  return { ...routineForm(r), ...changes };
}

describe("routinePatch", () => {
  it("sends nothing when the reader changed nothing", () => {
    expect(routinePatch(routine(), form(routine()))).toBeNull();
    const ruled = routine({ recurrence: serializeRoutineRule(daily(), null) });
    expect(routinePatch(ruled, form(ruled))).toBeNull();
  });

  it("sends the title alone when only the title changed", () => {
    const r = routine({ recurrence: serializeRoutineRule(daily(), null) });
    expect(routinePatch(r, form(r, { title: "Weekly issues" }))).toEqual({
      title: "Weekly issues",
    });
  });

  it("does not rewrite a rule that means what it meant", () => {
    // A rule stores the zone it was written in. Re-sending an untouched rule
    // from a machine in another zone would move the routine's wall clock.
    const stored = JSON.stringify({ kind: "daily", hour: 9, minute: 0, time_zone: "UTC" });
    const r = routine({ recurrence: stored });
    const patch = routinePatch(r, form(r, { prompt: "summarise everything" }));
    expect(patch).toEqual({ prompt: "summarise everything" });
    expect(patch).not.toHaveProperty("recurrence");
    expect(patch).not.toHaveProperty("next_due_at");
  });

  it("ignores the order the days were picked in", () => {
    const r = routine({
      recurrence: JSON.stringify({
        kind: "weekly",
        hour: 8,
        minute: 30,
        weekdays: [1, 3, 5],
        time_zone: "UTC",
      }),
    });
    const patch = routinePatch(
      r,
      form(r, { rule: { kind: "weekly", hour: 8, minute: 30, weekdays: [5, 1, 3] } }),
    );
    expect(patch).toBeNull();
  });

  it("sends the new rule and lets the daemon place the next run", () => {
    const r = routine({ recurrence: serializeRoutineRule(daily(), null) });
    const patch = routinePatch(
      r,
      form(r, { rule: { kind: "weekdays", hour: 9, minute: 0 }, nextRunMs: 1_800_000_000_000 }),
    );
    expect(Object.keys(patch ?? {})).toEqual(["recurrence"]);
    expect(JSON.parse(String(patch?.recurrence)).kind).toBe("weekdays");
  });

  it("turns an interval routine into a rule and back", () => {
    const interval = routine();
    const toRule = routinePatch(
      interval,
      form(interval, { rule: daily(), nextRunMs: interval.next_due_at }),
    );
    expect(Object.keys(toRule ?? {})).toEqual(["recurrence"]);

    const ruled = routine({ recurrence: serializeRoutineRule(daily(), null) });
    const back = routinePatch(
      ruled,
      form(ruled, { rule: null, intervalSecs: 3600, nextRunMs: 1_800_000_000_000 }),
    );
    // "" is how the daemon is told to drop the rule; the pace comes from the
    // form's interval and the next run from its date-time field.
    expect(back).toEqual({
      recurrence: "",
      interval_secs: 3600,
      next_due_at: 1_800_000_000_000,
    });
  });

  it("moves an interval routine's pace and first run only when they changed", () => {
    const r = routine();
    expect(routinePatch(r, form(r, { intervalSecs: 3600 }))).toEqual({ interval_secs: 3600 });
    expect(routinePatch(r, form(r, { nextRunMs: 1_800_000_000_000 }))).toEqual({
      next_due_at: 1_800_000_000_000,
    });
    expect(routinePatch(r, form(r, { intervalSecs: 3600, nextRunMs: r.next_due_at }))).toEqual({
      interval_secs: 3600,
    });
  });

  it("re-times a one-off, which is the one rule that owns an instant", () => {
    const r = routine({
      recurrence: JSON.stringify({ kind: "once", at: 1_700_000_000_000, time_zone: "UTC" }),
    });
    const patch = routinePatch(r, form(r, { nextRunMs: 1_800_000_000_000 }));
    expect(patch?.next_due_at).toBe(1_800_000_000_000);
    expect(JSON.parse(String(patch?.recurrence)).at).toBe(1_800_000_000_000);
    // Reading the stored instant back through the minute-truncating control
    // and saving again must leave it where it is.
    const shown = parseLocalDateTime(toLocalInputValue(new Date(r.next_due_at)));
    expect(routinePatch(r, form(r, { nextRunMs: shown }))).toBeNull();
  });

  it("does not move a next run the form can only show to the minute", () => {
    // An interval routine's next run is jittered with seconds; the date-time
    // control holds minutes. Saving the title must leave the instant alone.
    const stored = 1_700_000_012_345;
    const r = routine({ next_due_at: stored });
    // The real round trip the page performs on open.
    const shown = parseLocalDateTime(toLocalInputValue(new Date(stored)));
    expect(routinePatch(r, form(r, { title: "Renamed", nextRunMs: shown }))).toEqual({
      title: "Renamed",
    });
  });

  it("reads an empty next-run field as 'as soon as possible'", () => {
    // Create treats an empty field as the daemon's default, which is now; a
    // patch has no such default, so clearing the field has to send the instant
    // or the old one would silently stay.
    const now = 1_800_000_000_000;
    const r = routine();
    expect(routinePatch(r, form(r, { nextRunMs: null }), now)).toEqual({ next_due_at: now });
  });

  it("keeps a title it did not write", () => {
    // A title created elsewhere may be longer than the create form's 48-rune
    // fallback; saving a prompt change must not shorten it. An emptied field
    // means what it means in create: derive from the prompt.
    const long = "A".repeat(60);
    const r = routine({ title: long });
    expect(routinePatch(r, form(r, { prompt: "summarise the closed issues" }))).toEqual({
      prompt: "summarise the closed issues",
    });
    expect(routinePatch(r, form(r, { title: "" }))).toEqual({
      title: "summarise the open issues",
    });
  });

  it("keeps a rule in the zone it was written in", () => {
    // The stored hour is a wall clock in the stored zone. A desktop in another
    // zone must not reinterpret a phone's rule: a repeating rule has no single
    // instant to convert, and the offset changes with the other zone's DST.
    const foreign = ["Asia/Shanghai", "America/New_York", "Europe/Berlin"].find(
      (z) => z !== localTimeZone(),
    )!;
    const r = routine({
      recurrence: JSON.stringify({
        kind: "weekly",
        hour: 9,
        minute: 0,
        weekdays: [1],
        time_zone: foreign,
      }),
    });
    const patch = routinePatch(
      r,
      form(r, { rule: { kind: "weekly", hour: 9, minute: 0, weekdays: [2] } }),
    );
    expect(JSON.parse(String(patch?.recurrence))).toMatchObject({
      weekdays: [2],
      time_zone: foreign,
    });
  });

  it("leaves a rule that carries no zone without one", () => {
    // Rows written before the console stamped a zone, or by an API client that
    // omitted it, fire on the daemon's own local clock. A save must keep that,
    // not stamp the browser's zone over it.
    const r = routine({
      recurrence: JSON.stringify({ kind: "weekly", hour: 9, minute: 0, weekdays: [1] }),
    });
    const patch = routinePatch(
      r,
      form(r, { rule: { kind: "weekly", hour: 9, minute: 0, weekdays: [2] } }),
    );
    expect(JSON.parse(String(patch?.recurrence))).toMatchObject({
      weekdays: [2],
      time_zone: "",
    });
  });

  it("switches an interval routine to a one-off", () => {
    const r = routine();
    const patch = routinePatch(
      r,
      form(r, { rule: { kind: "once" }, nextRunMs: 1_800_000_000_000 }),
    );
    expect(JSON.parse(String(patch?.recurrence))).toMatchObject({
      kind: "once",
      at: 1_800_000_000_000,
    });
    // The instant travels inside the rule; the daemon derives next_due_at.
    expect(patch).not.toHaveProperty("next_due_at");
  });

  it("says nothing when a one-off has no instant", () => {
    // The page refuses to submit this; the library's answer is to leave the
    // schedule alone rather than drop the rule it cannot write.
    const r = routine({ recurrence: serializeRoutineRule(daily(), null) });
    expect(routinePatch(r, form(r, { rule: { kind: "once" }, nextRunMs: null }))).toBeNull();
  });

  it("drops a rule this console cannot read instead of leaving it to never fire", () => {
    // The form can only show an unreadable rule as interval mode, so saving it
    // applies what the reader sees.
    const r = routine({ recurrence: "{not json" });
    expect(routinePatch(r, form(r, { intervalSecs: 3600, nextRunMs: 1_800_000_000_000 }))).toEqual({
      recurrence: "",
      interval_secs: 3600,
      next_due_at: 1_800_000_000_000,
    });
  });

  it("compares permissions after normalisation, so an unknown stored mode is left alone", () => {
    const exotic = routine({ permission_mode: "plan" });
    expect(routinePatch(exotic, form(exotic))).toBeNull();
    const r = routine();
    expect(routinePatch(r, form(r, { permissionMode: "accept_edits" }))).toEqual({
      permission_mode: "accept_edits",
    });
  });

  it("sends the agent only when it changed", () => {
    const r = routine();
    expect(routinePatch(r, form(r, { agent: "claude-code" }))).toEqual({ agent: "claude-code" });
  });

  it("does not call a prompt with different surrounding space a change", () => {
    const r = routine({ prompt: "summarise the open issues\n" });
    expect(routinePatch(r, form(r, { prompt: "  summarise the open issues  " }))).toBeNull();
  });
});

describe("routineTitle", () => {
  it("falls back to the prompt and cuts at 48 characters", () => {
    expect(routineTitle("", "fix the tests")).toBe("fix the tests");
    const long = "一".repeat(60);
    expect(routineTitle("  ", long)).toBe("一".repeat(48) + "…");
  });
});
