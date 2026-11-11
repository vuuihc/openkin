import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The new-chat page's deep link, checked at the seam the page tests cannot see.
 *
 * `/new?q=` and `/new?cwd=` are entry points from the palette, the project
 * cover and the list. The sidebar list is mounted on the same route and writes
 * the URL on every search or filter change; an effect keyed on the params
 * object therefore re-applied the deep link mid-draft and snapped the folder
 * (or a cleared prompt) back to what the link said when the page opened.
 *
 * Source rather than DOM: mounting the page needs a daemon, a machine list and
 * the composer's provider catalog.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/NewChatPage.tsx"), "utf8");

describe("the new-chat deep link (KIN-START-001)", () => {
  it("applies each deep-link value once, not on every URL write", () => {
    expect(SOURCE).toContain('const deepLinkPrompt = params.get("q");');
    expect(SOURCE).toContain('const deepLinkCwd = params.get("cwd");');
    expect(SOURCE).toContain("}, [deepLinkPrompt]);");
    expect(SOURCE).toContain("}, [deepLinkCwd]);");
    // The params object changes identity on every location write, including
    // the sidebar list's own search and filter writes on this route.
    expect(SOURCE).not.toContain("}, [params]);");
  });
});
