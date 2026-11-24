import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";

/**
 * KIN-MOBILE-001 R1 — the light gate from ADR 0036 §4.
 *
 * A new suite nobody wires is a green light for a regression (the rule that
 * made the job id fixed in the ADR). This reads the real scripts/check.sh from
 * disk: the merge gate runs its default block, so the start line must be there
 * and the job must run both the typecheck and the jest suite.
 */

const CHECK_SH = path.resolve(__dirname, "../../../scripts/check.sh");
const START_LINE = /^\s*start mobile-rn job_mobile_rn\s*$/;

/** The `job_mobile_rn() { ... }` body, by brace balance, or null when absent. */
function jobBody(source: string, name: string): string | null {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^\\s*${name}\\(\\)\\s*\\{`).test(line));
  if (start === -1) return null;

  let depth = 0;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    body.push(line);
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
    }
    if (depth === 0) return body.join("\n");
  }
  return null;
}

describe("KIN-MOBILE-001 R1 gate wiring", () => {
  const source = fs.readFileSync(CHECK_SH, "utf8");
  const lines = source.split("\n");

  it("KIN-MOBILE-001: starts mobile-rn exactly once, in the default gate block", () => {
    const starts = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => START_LINE.test(line));
    expect(starts).toHaveLength(1);

    const allOnly = lines.findIndex((line) => line.trim() === "# BEGIN all-only jobs");
    expect(allOnly).toBeGreaterThanOrEqual(0);
    expect(starts[0].index).toBeLessThan(allOnly);
  });

  it("KIN-MOBILE-001: job_mobile_rn runs tsc --noEmit and jest", () => {
    const body = jobBody(source, "job_mobile_rn");
    expect(body).not.toBeNull();
    if (body === null) return;

    expect(body).toMatch(/npx\s+tsc\s+--noEmit/);
    expect(body).toMatch(/npx\s+jest\b/);
  });
});
