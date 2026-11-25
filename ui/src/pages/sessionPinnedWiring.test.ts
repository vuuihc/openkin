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

  it("leaves the device to the heading instead of repeating it on the row", () => {
    // KIN-CONTINUE-007: the row is title · agent · time · status. The device
    // heading above the project already names the machine, so the row neither
    // draws the label nor reads it into the accessible name.
    expect(ROW).not.toContain("{deviceLabel}");
    expect(ROW).not.toContain('row.remote ? deviceLabel || tr("machine.remote") : ""');
    expect(ROW).toContain("const label = [row.title, agent, at, status]");
  });
});
