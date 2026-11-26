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
const PACKAGE_JSON = path.resolve(__dirname, "../../package.json");
const START_LINE = /^\s*start mobile-rn job_mobile_rn\s*$/;

/**
 * Jest's own per-test default is 5 000 ms. The merge gate runs this suite in
 * parallel with the gate's other jobs on one Mac, and the same tree passes
 * alone, so a machine-load ceiling turns into a sendback for a defect that is
 * not there. 20 s was already raised once (#736) and recurred on 2026-11-26
 * 23:54: ListScreen.test.tsx exceeded 20 s inside a 44.9 s suite while the
 * same tree ran in 2.6 s alone, beside 21 other gate jobs. The manifest sets
 * 60 s — still far below the gate's budget, so a real hang fails — and this
 * floor rejects any return to jest's default.
 */
const MIN_GATE_TEST_TIMEOUT_MS = 60_000;

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

  it("KIN-MOBILE-001: job_mobile_rn installs only behind its node_modules stamp", () => {
    const body = jobBody(source, "job_mobile_rn");
    expect(body).not.toBeNull();
    if (body === null) return;

    // An unconditional install rewrote node_modules on every gate run, and npm
    // install's generated package-lock.json then tripped gate.sh's clean-tree
    // check on the next run. Each install sits inside its own stamp comparison
    // and the no-lockfile branch must not write one.
    expect(body).toContain("stamp=node_modules/.kin-lock-sha");
    expect(body).toContain("stamp=node_modules/.kin-pkg-sha");

    const bodyLines = body.split("\n").map((line) => line.trim());
    const installs = bodyLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^npm (ci|install)\b/.test(line));
    expect(installs.map(({ line }) => line)).toEqual([
      "npm ci --no-audit --no-fund || exit 1",
      "npm install --no-package-lock --no-audit --no-fund || exit 1",
    ]);
    for (const { index } of installs) {
      expect(bodyLines[index - 1]).toMatch(
        /^if \[\[ "\$\(cat "\$stamp" 2>\/dev\/null\)" != "\$want" \]\]; then$/,
      );
    }
  });

  it("KIN-MOBILE-001 R1: the gate gives a loaded run more than jest's 5 s default", () => {
    // The job's second command is a bare `npx jest --ci`, so the manifest is
    // the only place the ceiling lives. Read it from disk: a jest key in a
    // different package.json would not reach this suite.
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as {
      jest?: { preset?: string; testTimeout?: unknown };
    };
    expect(manifest.jest?.preset).toBe("jest-expo");
    expect(typeof manifest.jest?.testTimeout).toBe("number");
    expect(manifest.jest?.testTimeout as number).toBeGreaterThanOrEqual(
      MIN_GATE_TEST_TIMEOUT_MS,
    );
  });

  it("KIN-MOBILE-001 R1: the RN jest run does not fan out across every core beside the gate's other jobs", () => {
    // Jest sizes its pool from the core count by default, so a bare run
    // competes with the gate's 21 other jobs on one Mac — the contention that
    // pushed suites past 20 s on 2026-11-26. The job's second command is a
    // bare `npx jest --ci`, so the manifest key is the only place the worker
    // count lives; a `--maxWorkers`/`-w` token in the job would override it
    // silently and leave this pin staring at a value nothing reads.
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as {
      jest?: { maxWorkers?: unknown };
    };
    expect(typeof manifest.jest?.maxWorkers).toBe("number");
    expect(manifest.jest?.maxWorkers as number).toBeLessThanOrEqual(2);

    const body = jobBody(source, "job_mobile_rn");
    expect(body).not.toBeNull();
    if (body === null) return;
    const jestLines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /\bnpx\s+jest\b/.test(line));
    expect(jestLines).not.toHaveLength(0);
    for (const line of jestLines) {
      const tokens = line.split(/\s+/);
      expect(tokens).not.toContain("-w");
      for (const token of tokens) {
        expect(token.startsWith("--maxWorkers")).toBe(false);
      }
    }
  });
});
