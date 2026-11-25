import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KIN-CONTINUE-001, step 1: where the pinned section's machine name lives.
 *
 * The rule itself is `pinnedRowDeviceName` in `phoneSessionBuckets.test.ts`.
 * What is left is the wiring that has no unit of its own: the page has to ask
 * that rule for each row, and the row has to both show the answer and put it in
 * the accessible name. Drop either and the page still renders — a pinned
 * conversation from another machine simply reads as a local one, which is only
 * visible if you know which machine it came from.
 *
 * Source rather than DOM, like the other page wiring tests: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/components/sessions/SessionList.tsx"), "utf8");
const ROW = readFileSync(join(UI, "src/components/sessions/SessionRow.tsx"), "utf8");

describe("the pinned section's machine label", () => {
  it("asks the shared rule about every row", () => {
    expect(SOURCE).toContain("deviceLabel={pinnedRowDeviceName(bucket.key, row, machines)}");
  });

  it("shows the answer on the row and reads it out", () => {
    // `pinnedRowDeviceName` answers only for a pinned remote row, so the slot
    // is empty for every row under a device heading and nothing is repeated.
    // A pinned row sits outside that heading, and its `aria-label` overrides
    // the content: a label that left the machine out would tell a screen
    // reader a different story from the one the row shows.
    expect(ROW).toContain("{deviceLabel}");
    expect(ROW).toContain("const label = [row.title, agent, at, status, deviceLabel]");
  });
});
