// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import {
  localTimeZone,
  ROUTINE_HOUR_STEPS,
  ROUTINE_MINUTE_STEPS,
  type RoutineRule,
} from "../../lib/routineRecurrence";
import RoutineScheduleFields from "./RoutineScheduleFields";

/**
 * One select decides how often, and the row underneath asks only for what that
 * answer needs. What is pinned here is the contract with the page: a timer
 * choice clears the rule and sets the interval, and a clock choice sets the
 * rule and stops asking for a first run.
 */
function setup(
  rule: RoutineRule | null = null,
  ruleZone?: string | null,
  nextRunPreview?: number | null,
) {
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
      nextRunPreview={nextRunPreview}
    />,
  );
  return { onRuleChange, onIntervalChange, onNextRunLocalChange };
}

/** The console picker puts one trigger per surface in the DOM; the desktop one
 *  is the `listbox` and the phone one opens the `Sheet`. The repeat control is
 *  the first picker on the row, the step control (when present) the second. */
const trigger = (surface: "listbox" | "dialog", index = 0) =>
  document.querySelectorAll<HTMLButtonElement>(`button[aria-haspopup="${surface}"]`)[index];

const repeat = () => trigger("listbox", 0);
const step = () => trigger("listbox", 1);

async function pickDesktop(index: number, optionName: string) {
  await userEvent.click(trigger("listbox", index));
  await userEvent.click(screen.getByRole("option", { name: optionName }));
}

const optionNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("RoutineScheduleFields", () => {
  it("offers an interval and a time of day as separate answers", () => {
    setup();
    expect(repeat().textContent).toContain(t("routines.interval1d"));
    // An interval routine needs a first run; a rule computes its own.
    expect(screen.getByLabelText(t("routines.firstRunLabel"))).toBeTruthy();
  });

  it("switches from a timer to a rule", async () => {
    const { onRuleChange, onIntervalChange } = setup();
    await pickDesktop(0, t("routines.repeatWeekdays"));
    expect(onRuleChange).toHaveBeenCalledWith({ kind: "weekdays", hour: 9, minute: 0 });
    expect(onIntervalChange).not.toHaveBeenCalled();
  });

  it("switches from a rule back to a timer", async () => {
    const { onRuleChange, onIntervalChange } = setup({ kind: "daily", hour: 9, minute: 0 });
    await pickDesktop(0, t("routines.interval1h"));
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

  it("switches to a step rule with a step the daemon accepts", async () => {
    const { onRuleChange } = setup();
    await pickDesktop(0, t("routines.repeatEveryHours"));
    expect(onRuleChange).toHaveBeenCalledWith({ kind: "hours", every: 6 });
    await pickDesktop(0, t("routines.repeatEveryMinutes"));
    expect(onRuleChange).toHaveBeenCalledWith({ kind: "minutes", every: 15 });
  });

  it("asks a step rule for its step, not a time of day", async () => {
    setup({ kind: "minutes", every: 15 });
    expect(step().textContent).toContain(t("routines.everyNMinutes", { n: 15 }));
    await userEvent.click(step());
    // Only the steps the daemon accepts: a step that does not divide the hour
    // would shorten the last gap of every hour.
    expect(optionNames(screen.getByRole("listbox", { name: t("routines.everyLabel") }))).toEqual(
      ROUTINE_MINUTE_STEPS.map((n) => t("routines.everyNMinutes", { n })),
    );
    expect(screen.queryByLabelText(t("routines.timeLabel"))).toBeNull();
    expect(screen.queryByLabelText(t("routines.firstRunLabel"))).toBeNull();
  });

  it("edits the hours step without changing the kind", async () => {
    const { onRuleChange } = setup({ kind: "hours", every: 6 });
    await userEvent.click(step());
    expect(optionNames(screen.getByRole("listbox", { name: t("routines.everyLabel") }))).toEqual(
      ROUTINE_HOUR_STEPS.map((n) => t("routines.everyNHours", { n })),
    );
    await userEvent.click(
      screen.getByRole("option", { name: t("routines.everyNHours", { n: 8 }) }),
    );
    expect(onRuleChange).toHaveBeenCalledWith({ kind: "hours", every: 8 });
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

  it("shows the next run the daemon computed for a repeated rule", () => {
    // The line is the daemon's answer, not the form's arithmetic: the same
    // instant create would store. It is formatted in the reader's locale.
    const at = new Date("2026-03-02T09:30:00").getTime();
    setup({ kind: "daily", hour: 9, minute: 30 }, undefined, at);
    expect(
      screen.getByText(t("routines.nextRunPreview", { when: new Date(at).toLocaleString() })),
    ).toBeTruthy();
  });

  it("reads the line on the rule's own clock", () => {
    // The time field above shows the rule's wall clock, not the reader's, so
    // the sentence underneath has to use that same face. The zone is picked by
    // rendered output, not name: zones that share an offset (Asia/Shanghai and
    // Asia/Singapore) print the same wall clock, and a name-only pick would let
    // the assertion pass on the reader's own formatting.
    const at = new Date("2026-03-02T09:30:00").getTime();
    const foreign = ["Asia/Shanghai", "America/New_York", "Europe/Berlin"].find(
      (z) =>
        new Date(at).toLocaleString(undefined, { timeZone: z }) !== new Date(at).toLocaleString(),
    )!;
    setup({ kind: "daily", hour: 9, minute: 30 }, foreign, at);
    expect(
      screen.getByText(
        t("routines.nextRunPreview", {
          when: new Date(at).toLocaleString(undefined, { timeZone: foreign }),
        }),
      ),
    ).toBeTruthy();
  });

  it("shows no next run until the daemon has answered", () => {
    // A missing answer is not "now" and not a client-side guess: the line is
    // simply absent, and a transport failure reads the same way.
    setup({ kind: "daily", hour: 9, minute: 30 }, undefined, null);
    const prefix = t("routines.nextRunPreview", { when: "" }).trim();
    expect(document.body.textContent).not.toContain(prefix);
  });

  it("does not repeat a one-off's instant above its own field", () => {
    // The date-time control already shows when it fires; a second line naming
    // the same instant would only crowd the form.
    setup({ kind: "once" }, undefined, 1_800_000_000_000);
    const prefix = t("routines.nextRunPreview", { when: "" }).trim();
    expect(document.body.textContent).not.toContain(prefix);
  });

  it("picks a rule from the phone's sheet", async () => {
    // 390px is a sheet, not a system wheel: the same list of answers the
    // desktop panel shows, on the surface the phone owns.
    const { onRuleChange } = setup();
    await userEvent.click(trigger("dialog", 0));
    const dialog = screen.getByRole("dialog", { name: t("routines.repeatLabel") });
    await userEvent.click(within(dialog).getByRole("button", { name: t("routines.repeatWeekly") }));
    expect(onRuleChange).toHaveBeenCalledWith({
      kind: "weekly",
      hour: 9,
      minute: 0,
      weekdays: [1],
    });
  });
});
