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
