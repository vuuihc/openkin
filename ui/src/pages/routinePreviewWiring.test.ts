import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The next-run line under a routine's schedule.
 *
 * `useRoutinePreview.test.tsx` holds the request contract (debounce, staleness,
 * clearing). What is left is the page and the control: that the preview is
 * asked for with exactly the rule a save would send, that a one-off and an
 * interval ask for nothing, and that the answer reaches the line the reader
 * sees.
 *
 * Source rather than DOM: mounting this page needs a daemon, a task feed, an
 * agent list and a router.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = readFileSync(join(UI, "src/pages/RoutinesPage.tsx"), "utf8");
const FIELDS = readFileSync(join(UI, "src/components/routine/RoutineScheduleFields.tsx"), "utf8");

describe("the routine form's next-run preview", () => {
  it("asks about the rule a save would send, zone included", () => {
    // A stored rule keeps the zone it was written in. Previewing it in the
    // browser's zone would name an instant the routine never fires at.
    expect(PAGE).toContain(
      "return serializeRoutineRule(routineRule, null, ruleZone ?? localTimeZone());",
    );
    expect(PAGE).toContain("const rulePreviewAt = useRoutinePreview(rulePayload);");
  });

  it("asks nothing for a schedule that has no rule", () => {
    // An interval has no rule to parse, and a one-off already shows its
    // instant in the date field.
    expect(PAGE).toContain('if (!routineRule || routineRule.kind === "once") return "";');
  });

  it("hands the daemon's answer to the schedule fields", () => {
    expect(PAGE).toContain("nextRunPreview={rulePreviewAt}");
    expect(FIELDS).toContain("nextRunPreview != null");
    expect(FIELDS).toContain('rule.kind !== "once"');
  });
});
