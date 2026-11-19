import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The give-up edge.
 *
 * `recoverWhenDaemonAppears` is the only place that learns the five-minute
 * retry ran out, and `boot.fail` is the only way that reaches the window. The
 * retry's other outcomes are not failures: "resolved" means something else
 * changed the daemon's state and the shell must leave it alone. Comments are
 * stripped first, for the reason spelled out in `quit.wiring.test.ts`.
 */
const RAW = readFileSync(
  existsSync("src/main.ts") ? "src/main.ts" : "desktop/src/main.ts",
  "utf8",
);
const SOURCE = RAW.replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "").replace(/^\s*\/\/.*$/gm, "");

/** The braces-balanced block that follows `marker`, `{` included. */
function blockAfter(marker: string): string {
  const at = SOURCE.indexOf(marker);
  assert.ok(at >= 0, `no ${marker}`);
  const open = SOURCE.indexOf("{", at + marker.length);
  assert.ok(open > at, `${marker} has no block`);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}" && (depth -= 1) === 0) {
      return SOURCE.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced block after ${marker}`);
}

describe("reporting a daemon that never arrives", () => {
  it("the give-up edge reaches boot.fail", () => {
    const body = blockAfter("function recoverWhenDaemonAppears");
    const failed = blockAfter('if (effect === "failed")');

    assert.match(
      failed,
      /boot\.fail\(reasonFrom\(reason\)\)/,
      "giving up does not tell the window why",
    );
    assert.equal(
      body.match(/boot\.fail\(/g)?.length,
      1,
      "a boot.fail call sits outside the failed edge",
    );
    // `resolved` maps to "none" (proven in boot-failure.test.ts) and returns
    // through this guard, so the only failure edge is "gave-up".
    assert.match(body, /if \(effect === "none"\) return;/, "resolved can reach the recovery path");
  });

  it("startup hands over the handshake reason; the tray retry has none", () => {
    assert.match(
      SOURCE,
      /void recoverWhenDaemonAppears\(status\.reason\)/,
      "the unavailable branch drops the reason the handshake already knows",
    );
    assert.match(
      SOURCE,
      /void recoverWhenDaemonAppears\(\)/,
      "the tray's Start daemon path should ask without a reason",
    );
  });
});
