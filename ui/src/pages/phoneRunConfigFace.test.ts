import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One run-configuration entry per page, one arrangement at each width.
 *
 * Two pages own these settings and they answer the question differently:
 *
 * - The session page keeps its phone face (`md:hidden`) and a desktop strip
 *   (`hidden md:flex`); the two are presentations of the same settings and
 *   the only thing keeping them apart is that pair of display gates pointing
 *   in opposite directions. Delete either and nothing else fails while the
 *   desktop grows a second model picker or the phone loses its only one.
 * - The new-chat page deliberately has no strip: one face at every width,
 *   and the settings surface behind it owns the location rows. A second
 *   arrangement (the eight-chip sideways scroller that used to sit below the
 *   composer) is the defect `gap-log` 2026-11-08 recorded; the draft's folder
 *   lives above the composer, with the project it names.
 *
 * Source rather than DOM, like `phoneKeyboardHints.test.ts`: "this element
 * carries these classes / this page does not render that strip" is a property
 * of the source text, and rendering the page for real needs a live task, a
 * daemon and a machine list.
 *
 * KIN-CONTINUE-001 keeps the session page's gate: the selectors moved into
 * anchored layers, but there is still exactly one run-config control at each
 * width.
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
  it("is hidden from md up unless the page asks for it at every width", () => {
    const composer = read("src/components/chat/Composer.tsx");
    // The gate is a prop now, but the default must stay phone-only: the
    // session page still has a desktop strip of its own.
    expect(composer).toContain('footerWide ? "" : "md:hidden"');
    expect(composer).toContain("footerWide = false");
  });

  it("keeps the session page's desktop strip opposite the phone face", () => {
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

  it("is the new-chat page's only run control, at every width", () => {
    const source = read("src/pages/NewChatPage.tsx");
    // The draft's agent, model and mode have to be visible and changeable
    // before sending; the face is the one entry on a phone and on a Mac.
    const footerAt = source.indexOf("footer={");
    expect(footerAt).toBeGreaterThan(-1);
    expect(source.indexOf("<RunConfigControl", footerAt)).toBeGreaterThan(footerAt);
    expect(source.indexOf("footerWide", footerAt)).toBeGreaterThan(footerAt);
    // The face's settings surface must carry the location controls the draft
    // owns (machine, branch, dispatch, routine)...
    expect(source.indexOf("extraRows=")).toBeGreaterThan(footerAt);
    // ...and no second arrangement below the composer: no desktop strip, no
    // second open-state flag.
    expect(source).not.toContain("desktopStrip");
    expect(source).not.toContain("md:flex items-center gap-x-2");
    expect(source.indexOf("setControlsOpen")).toBe(-1);
  });

  it("puts the draft's folder above the composer, not in the run surface", () => {
    const source = read("src/pages/NewChatPage.tsx");
    // The folder names the conversation; the project card below it answers
    // with that folder's summary. Both sit above the composer.
    const cwdAt = source.indexOf('renderControl("cwd")');
    const composerAt = source.indexOf("<Composer");
    expect(cwdAt).toBeGreaterThan(-1);
    expect(composerAt).toBeGreaterThan(cwdAt);
    // The run surface still names machine / branch / dispatch / routine.
    for (const id of ['"machine"', '"branch"', '"dispatch"', '"routine"']) {
      expect(source).toContain(id);
    }
  });
});
