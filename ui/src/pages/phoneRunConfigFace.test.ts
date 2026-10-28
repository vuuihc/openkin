import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One run-configuration control per width.
 *
 * The composer's face and the strip under the composer are two presentations of
 * the same two settings, and the only thing keeping them from appearing
 * together is a pair of display gates pointing in opposite directions: the
 * face's slot is `md:hidden`, the strip is `hidden md:flex`. Delete either and
 * nothing else fails — the types stay happy and no DOM test mounts
 * `TaskDetailPage` — while the desktop grows a second model picker and the
 * phone loses its only one.
 *
 * Source rather than DOM, like `phoneKeyboardHints.test.ts`: "this element
 * carries these two classes" is a property of the source text, and rendering
 * the page for real needs a live task, a daemon and a machine list.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));

const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

/** The class list of the last `<tag className="…">` before `needle`. */
function classesBefore(source: string, needle: string, tag: string): string {
  const at = source.indexOf(needle);
  if (at === -1) return "";
  const re = new RegExp(`<${tag} className="([^"]*)"`, "g");
  const all = [...source.slice(0, at).matchAll(re)];
  return all[all.length - 1]?.[1] ?? "";
}

describe("the composer's run-config face", () => {
  it("is hidden from md up", () => {
    const classes = classesBefore(read("src/components/chat/Composer.tsx"), "{footer}", "div");
    expect(classes).not.toBe("");
    expect(classes.split(/\s+/)).toContain("md:hidden");
  });

  it("leaves the desktop strip to carry the same two settings from md up", () => {
    const classes = classesBefore(
      read("src/pages/TaskDetailPage.tsx"),
      "<PermissionModePicker",
      "div",
    );
    expect(classes).not.toBe("");
    const tokens = classes.split(/\s+/);
    expect(tokens).toContain("hidden");
    expect(tokens).toContain("md:flex");
  });
});
