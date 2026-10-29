// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { localTimeZone, type RoutineRule } from "../../lib/routineRecurrence";
import RoutineScheduleFields from "./RoutineScheduleFields";

/**
 * One select decides how often, and the row underneath asks only for what that
 * answer needs. What is pinned here is the contract with the page: a timer
 * choice clears the rule and sets the interval, and a clock choice sets the
 * rule and stops asking for a first run.
 */
function setup(rule: RoutineRule | null = null, ruleZone?: string | null) {
  const onRuleChange = vi.fn();
  const onIntervalChange = vi.fn();
  const onNextRunLocalChange = vi.fn();
  render(
    <RoutineScheduleFields
      intervalSecs={86400}
      onIntervalChange={onIntervalChange}
      nextRunLocal="2026-03-02T15:00"
      onNextRunLocalChange={onNextRunLocalChange}
      rule={rule}
      onRuleChange={onRuleChange}
      ruleZone={ruleZone}
    />,
  );
  return { onRuleChange, onIntervalChange, onNextRunLocalChange };
}

const repeat = () => screen.getByLabelText(t("routines.repeatLabel")) as HTMLSelectElement;

describe("RoutineScheduleFields", () => {
  it("offers an interval and a time of day as separate answers", () => {
    setup();
    expect(repeat().value).toBe("interval:86400");
    // An interval routine needs a first run; a rule computes its own.
    expect(screen.getByLabelText(t("routines.firstRunLabel"))).toBeTruthy();
  });

  it("switches from a timer to a rule", () => {
    const { onRuleChange, onIntervalChange } = setup();
    fireEvent.change(repeat(), { target: { value: "weekdays" } });
    expect(onRuleChange).toHaveBeenCalledWith({ kind: "weekdays", hour: 9, minute: 0 });
    expect(onIntervalChange).not.toHaveBeenCalled();
  });

  it("switches from a rule back to a timer", () => {
    const { onRuleChange, onIntervalChange } = setup({ kind: "daily", hour: 9, minute: 0 });
    fireEvent.change(repeat(), { target: { value: "interval:3600" } });
    expect(onRuleChange).toHaveBeenCalledWith(null);
    expect(onIntervalChange).toHaveBeenCalledWith(3600);
  });

  it("asks for a time of day, not a first run, once a rule is chosen", () => {
    setup({ kind: "daily", hour: 9, minute: 30 });
    const time = screen.getByLabelText(t("routines.timeLabel")) as HTMLInputElement;
    expect(time.value).toBe("09:30");
    expect(screen.queryByLabelText(t("routines.firstRunLabel"))).toBeNull();
  });

  it("edits the clock without changing the kind", () => {
    const { onRuleChange } = setup({ kind: "weekly", hour: 9, minute: 0, weekdays: [1] });
    fireEvent.change(screen.getByLabelText(t("routines.timeLabel")), {
      target: { value: "18:45" },
    });
    expect(onRuleChange).toHaveBeenCalledWith({
      kind: "weekly",
      hour: 18,
      minute: 45,
      weekdays: [1],
    });
  });

  it("keeps at least one weekday chosen", () => {
    const { onRuleChange } = setup({ kind: "weekly", hour: 9, minute: 0, weekdays: [1] });
    // Turning off the only chosen day would be a weekly rule with no days,
    // which the daemon refuses to store.
    fireEvent.click(screen.getByRole("button", { name: t("routines.weekday1") }));
    expect(onRuleChange).not.toHaveBeenCalled();
    // A second day is additive.
    fireEvent.click(screen.getByRole("button", { name: t("routines.weekday3") }));
    expect(onRuleChange).toHaveBeenCalledWith({
      kind: "weekly",
      hour: 9,
      minute: 0,
      weekdays: [1, 3],
    });
  });

  it("asks for a date, not a time, once a month", () => {
    const { onRuleChange } = setup({ kind: "monthly", hour: 9, minute: 0, days: [1] });
    fireEvent.change(screen.getByLabelText(t("routines.dayOfMonthLabel")), {
      target: { value: "15" },
    });
    expect(onRuleChange).toHaveBeenCalledWith({
      kind: "monthly",
      hour: 9,
      minute: 0,
      days: [15],
    });
  });

  it("keeps the one date-time control for a one-off", () => {
    setup({ kind: "once" });
    expect(screen.getByLabelText(t("routines.onceLabel"))).toBeTruthy();
    expect(screen.queryByLabelText(t("routines.timeLabel"))).toBeNull();
  });

  it("names the zone the rule's time is in", () => {
    // A rule written on a phone in another zone keeps that zone when it is
    // edited here; claiming the times are the reader's would describe a firing
    // time the routine does not have. The zone is chosen to differ from the
    // test runner's, so the assertion cannot pass by coincidence.
    const foreign = ["Asia/Shanghai", "America/New_York", "Europe/Berlin"].find(
      (z) => z !== localTimeZone(),
    )!;
    setup({ kind: "daily", hour: 9, minute: 0 }, foreign);
    expect(screen.getByText(t("routines.ruleTimezone", { zone: foreign }))).toBeTruthy();
  });

  it("says a zone-less rule runs on the machine's clock", () => {
    // A stored rule with no zone is the daemon's local time, which the console
    // cannot name; it must not claim the reader's zone instead.
    setup({ kind: "daily", hour: 9, minute: 0 }, "");
    expect(screen.getByText(t("routines.ruleTimezoneDaemon"))).toBeTruthy();
  });
});
