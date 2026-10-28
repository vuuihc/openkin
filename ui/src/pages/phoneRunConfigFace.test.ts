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

/** The class list of the `<tag …>` whose attributes contain `needle`. */
function classesOf(source: string, needle: string, tag: string): string {
  const at = source.indexOf(needle);
  if (at === -1) return "";
  const start = source.lastIndexOf(`<${tag}`, at);
  if (start === -1) return "";
  const element = source.slice(start, source.indexOf(">", at));
  return /className="([^"]*)"/.exec(element)?.[1] ?? "";
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

  it("is the new-chat page's only run control before the first message", () => {
    const source = read("src/pages/NewChatPage.tsx");
    // The draft's agent, model and mode have to be visible and changeable
    // before sending; without the face a phone inherits whatever the last
    // draft set and cannot see it.
    const footerAt = source.indexOf("footer={");
    expect(footerAt).toBeGreaterThan(-1);
    expect(source.indexOf("<RunConfigControl", footerAt)).toBeGreaterThan(footerAt);
    // The face's sheet must carry the location controls a phone cannot reach
    // any other way (the old second entry, the "run summary" bar and its
    // sheet, is gone — one entry, one sheet).
    expect(source.indexOf("extraRows=")).toBeGreaterThan(footerAt);
    expect(source.indexOf("setControlsOpen")).toBe(-1);

    const classes = classesOf(source, "md:flex items-center gap-x-2", "div");
    expect(classes).not.toBe("");
    const tokens = classes.split(/\s+/);
    expect(tokens).toContain("hidden");
    expect(tokens).toContain("md:flex");
  });
});
