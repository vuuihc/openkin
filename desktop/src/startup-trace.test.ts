import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STARTUP_TRACE_MAX_AGE_MS,
  createStartupTrace,
  formatMark,
  resolveStartupOrigin,
} from "./startup-trace.ts";

/**
 * The desktop half of KIN_STARTUP_TRACE.
 *
 * The daemon already emits phase lines (internal/server/startup_trace.go).
 * The shell needs the same shape so one launch can be attributed from process
 * spawn to first paint, and so a launcher can hand it the true spawn instant.
 * The rules that matter: off is silent, an implausible exported origin is
 * ignored rather than trusted, and a mark never breaks the boot.
 */

const T0 = 1_700_000_000_000;

function collector() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("desktop startup trace", () => {
  it("is silent without KIN_STARTUP_TRACE=1", () => {
    const out = collector();
    const mark = createStartupTrace({}, () => T0, out.write);
    mark("process");
    mark("app-ready");
    assert.deepEqual(out.lines, []);
  });

  it("uses a plausible origin exported by the launcher", () => {
    const out = collector();
    let now = T0 + 250;
    const mark = createStartupTrace(
      { KIN_STARTUP_TRACE: "1", KIN_STARTUP_ORIGIN_MS: String(T0) },
      () => now,
      out.write,
    );
    mark("sidecar-ready");
    now = T0 + 1_000;
    mark("window-shown");
    assert.deepEqual(out.lines, [
      "[kin-desktop] trace sidecar-ready 250",
      "[kin-desktop] trace window-shown 1000",
    ]);
  });

  it("does not trust an origin in the future", () => {
    assert.equal(
      resolveStartupOrigin({ KIN_STARTUP_ORIGIN_MS: String(T0 + 1_000) }, T0),
      T0,
    );
  });

  it("does not trust an origin older than ten minutes", () => {
    const stale = T0 - STARTUP_TRACE_MAX_AGE_MS - 1;
    assert.equal(
      resolveStartupOrigin({ KIN_STARTUP_ORIGIN_MS: String(stale) }, T0),
      T0,
    );
    // Exactly at the bound is still this launch.
    const edge = T0 - STARTUP_TRACE_MAX_AGE_MS;
    assert.equal(resolveStartupOrigin({ KIN_STARTUP_ORIGIN_MS: String(edge) }, T0), edge);
    assert.equal(resolveStartupOrigin({ KIN_STARTUP_ORIGIN_MS: "not-a-number" }, T0), T0);
  });

  it("prints one integer-millisecond line per mark", () => {
    const out = collector();
    const mark = createStartupTrace(
      { KIN_STARTUP_TRACE: "1" },
      () => T0 + 40.7,
      out.write,
    );
    mark("process");
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0]!, /^\[kin-desktop\] trace process \d+$/);
    assert.equal(out.lines[0], "[kin-desktop] trace process 0");
    assert.equal(formatMark("window-created", 1234), "[kin-desktop] trace window-created 1234");
  });

  it("never throws when the log stream is broken", () => {
    const mark = createStartupTrace(
      { KIN_STARTUP_TRACE: "1" },
      () => T0,
      () => {
        throw new Error("EPIPE");
      },
    );
    assert.doesNotThrow(() => mark("process"));
  });
});
