import { describe, expect, it } from "vitest";
import {
  defaultOnceLocalValue,
  describeRoutineRule,
  formatRuleTime,
  parseRoutineRule,
  ruleTimeZone,
  serializeRoutineRule,
  type RoutineRule,
} from "./routineRecurrence";

/** A `tr` that names its key and params, so the test sees what was asked for. */
const tr = (key: string, params?: Record<string, string | number>) =>
  params
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key;

describe("routine recurrence", () => {
  it("writes the rule the daemon validates", () => {
    const daily: RoutineRule = { kind: "daily", hour: 9, minute: 5 };
    const parsed = JSON.parse(serializeRoutineRule(daily, null)) as Record<string, unknown>;
    expect(parsed.kind).toBe("daily");
    expect(parsed.hour).toBe(9);
    expect(parsed.minute).toBe(5);
    // The daemon interprets the time in this zone, not in its own.
    expect(typeof parsed.time_zone).toBe("string");
    expect((parsed.time_zone as string).length).toBeGreaterThan(0);
  });

  it("sorts the days it writes", () => {
    const weekly = JSON.parse(
      serializeRoutineRule({ kind: "weekly", hour: 18, minute: 0, weekdays: [5, 1, 3] }, null),
    ) as { weekdays: number[] };
    expect(weekly.weekdays).toEqual([1, 3, 5]);

    const monthly = JSON.parse(
      serializeRoutineRule({ kind: "monthly", hour: 9, minute: 0, days: [31, 1, 15] }, null),
    ) as { days: number[] };
    expect(monthly.days).toEqual([1, 15, 31]);
  });

  it("has no rule for an interval routine, or for a one-off with no instant", () => {
    expect(serializeRoutineRule(null, null)).toBe("");
    expect(serializeRoutineRule({ kind: "once" }, null)).toBe("");
    const once = JSON.parse(serializeRoutineRule({ kind: "once" }, 1_800_000_000_000)) as Record<
      string,
      unknown
    >;
    expect(once.kind).toBe("once");
    expect(once.at).toBe(1_800_000_000_000);
  });

  it("reads back what it wrote", () => {
    const rules: RoutineRule[] = [
      { kind: "daily", hour: 9, minute: 0 },
      { kind: "weekdays", hour: 8, minute: 30 },
      { kind: "weekly", hour: 18, minute: 0, weekdays: [1, 3] },
      { kind: "monthly", hour: 9, minute: 0, days: [1, 15] },
      { kind: "once" },
    ];
    for (const rule of rules) {
      const raw = serializeRoutineRule(rule, rule.kind === "once" ? 1 : null);
      expect(parseRoutineRule(raw)).toEqual(rule);
    }
  });

  it("writes the zone it is given, not the browser's", () => {
    // An edit keeps a rule in the zone it was written in; the stored hour is a
    // wall clock in that zone.
    const raw = serializeRoutineRule({ kind: "daily", hour: 9, minute: 5 }, null, "Asia/Shanghai");
    expect((JSON.parse(raw) as Record<string, unknown>).time_zone).toBe("Asia/Shanghai");
  });

  it("reads the zone a stored rule is expressed in", () => {
    expect(ruleTimeZone(`{"kind":"daily","hour":9,"time_zone":"Asia/Shanghai"}`)).toBe(
      "Asia/Shanghai",
    );
    // A rule with no zone is fired on the daemon's local clock; "" says so,
    // which is different from "no rule at all".
    expect(ruleTimeZone(`{"kind":"daily","hour":9}`)).toBe("");
    expect(ruleTimeZone(`{"kind":"daily","hour":9,"time_zone":""}`)).toBe("");
    expect(ruleTimeZone(`{"kind":"daily","hour":9,"time_zone":"Mars/Olympus"}`)).toBeNull();
    expect(ruleTimeZone("not json")).toBeNull();
    expect(ruleTimeZone(null)).toBeNull();
  });

  it("treats an unreadable rule as no rule", () => {
    expect(parseRoutineRule("")).toBeNull();
    expect(parseRoutineRule("   ")).toBeNull();
    expect(parseRoutineRule("not json")).toBeNull();
    expect(parseRoutineRule("[]")).toBeNull();
    expect(parseRoutineRule(`{"kind":"hourly","hour":1}`)).toBeNull();
    // A weekly rule with no days, or a day out of range, is not a rule.
    expect(parseRoutineRule(`{"kind":"weekly","hour":9}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"weekly","hour":9,"weekdays":[9]}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"monthly","hour":9,"days":[0]}`)).toBeNull();
    // The rest of what the daemon's Validate refuses: a clock it cannot fire,
    // a repeated day, a zone it cannot load, a one-off with no instant.
    expect(parseRoutineRule(`{"kind":"daily","hour":25,"minute":0}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"daily","hour":9,"minute":60}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"weekly","hour":9,"weekdays":[1,1]}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"daily","hour":9,"time_zone":"Mars/Olympus"}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"once"}`)).toBeNull();
    expect(parseRoutineRule(`{"kind":"once","at":0}`)).toBeNull();
    // Missing clock fields default to midnight, as the Go struct does.
    expect(parseRoutineRule(`{"kind":"daily"}`)).toEqual({ kind: "daily", hour: 0, minute: 0 });
  });

  it("formats the time of day", () => {
    expect(formatRuleTime({ kind: "daily", hour: 9, minute: 5 })).toBe("09:05");
    expect(formatRuleTime({ kind: "daily", hour: 23, minute: 59 })).toBe("23:59");
    expect(formatRuleTime({ kind: "once" })).toBe("");
  });

  it("names the rule for the list", () => {
    expect(describeRoutineRule(null, tr)).toBeNull();
    // A one-off says nothing here: the list already shows its next run.
    expect(describeRoutineRule({ kind: "once" }, tr)).toBeNull();
    expect(describeRoutineRule({ kind: "daily", hour: 9, minute: 0 }, tr)).toBe(
      "routines.ruleDaily(time=09:00)",
    );
    expect(describeRoutineRule({ kind: "weekly", hour: 18, minute: 0, weekdays: [1, 3] }, tr)).toBe(
      "routines.ruleWeekly(time=18:00,days=routines.weekday1, routines.weekday3)",
    );
    expect(describeRoutineRule({ kind: "monthly", hour: 9, minute: 0, days: [1, 15] }, tr)).toBe(
      "routines.ruleMonthly(time=09:00,days=1, 15)",
    );
  });

  it("defaults a one-off to the next top of the hour", () => {
    const value = defaultOnceLocalValue(new Date(2026, 2, 2, 14, 37));
    expect(value).toBe("2026-03-02T15:00");
  });
});
