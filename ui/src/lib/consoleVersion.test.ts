import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEntryChunk } from "./consoleVersion";

/**
 * The document the console ships in names the entry chunk it runs in one module
 * script. Finding that path is what lets a resumed page compare itself with the
 * server: the stylesheet, a classic script, and the dev server's uncompiled
 * entry are not the bundle the document is executing.
 */

const PRODUCTION_INDEX = `<!doctype html>
<html lang="zh-Hans" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" crossorigin href="/assets/index-CmDM6QBr.css" />
    <script type="module" crossorigin src="/assets/index-hlv2Xdq0.js?v=3"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("parseEntryChunk", () => {
  it("parses the module entry chunk from a production index", () => {
    expect(parseEntryChunk(PRODUCTION_INDEX)).toBe("/assets/index-hlv2Xdq0.js");
  });

  it("returns null for a dev entry or markup without a module script", () => {
    expect(parseEntryChunk('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(parseEntryChunk("<!doctype html><html><body></body></html>")).toBeNull();
    expect(parseEntryChunk('<script src="/src/main.tsx"></script>')).toBeNull();
  });

  it("ignores non-module scripts", () => {
    expect(parseEntryChunk('<script src="/assets/other.js"></script>')).toBeNull();
    // Even an entry-shaped path is not the entry unless it is a module script.
    expect(parseEntryChunk('<script src="/assets/index-hlv2Xdq0.js"></script>')).toBeNull();
  });
});

describe("the console's version watch", () => {
  it("is installed after the first paint, on both ways a page resumes", () => {
    // Without the call, a phone left open across a deploy never catches up and
    // every unit test above still passes: the check is correct, it is simply
    // never asked. The gates are the feature too — checking on every
    // visibility change would run it on the way *out* of the app, and an
    // ungated pageshow fires on the first load before the console has painted.
    const ui = existsSync(join(process.cwd(), "src/main.tsx"))
      ? process.cwd()
      : join(process.cwd(), "ui");
    const main = readFileSync(join(ui, "src/main.tsx"), "utf8");
    const call = main.indexOf("watchConsoleVersion();");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(main.indexOf("createRoot(root).render"));
    expect(main).toContain('document.addEventListener("visibilitychange"');
    expect(main).toContain('document.visibilityState === "visible"');
    expect(main).toContain('window.addEventListener("pageshow"');
    expect(main).toContain("if (event.persisted)");
  });
});
