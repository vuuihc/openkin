import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One run-configuration entry per page, one arrangement at each width.
 *
 * Both pages that own these settings answer the question the same way: one
 * face at every width, and the settings surface behind it owns the details.
 *
 * - The session page used to keep a phone face (`md:hidden`) opposite a
 *   desktop strip (`hidden md:flex`). The strip was a crowded second
 *   arrangement of the same settings — the UX gate measured it as the busiest
 *   part of the card — and the face now carries every width. What the session
 *   is (folder, repository, branch, machine) moved into the face's own sheet.
 * - The new-chat page has no strip either: one face at every width, and the
 *   settings surface behind it owns the location rows. A second arrangement
 *   (the eight-chip sideways scroller that used to sit below the composer) is
 *   the defect `gap-log` 2026-11-08 recorded. The machine and the project left
 *   the run surface in KIN-START-001: they are one place row under the card,
 *   not two rows inside the settings layer.
 *
 * Source rather than DOM, like `phoneKeyboardHints.test.ts`: "this element
 * carries these classes / this page does not render that strip" is a property
 * of the source text, and rendering the page for real needs a live task, a
 * daemon and a machine list.
 *
 * KIN-CONTINUE-001 still holds: there is exactly one run-config control at
 * each width. Only the mechanism changed — one face that picks a sheet or an
 * anchored panel, instead of two arrangements hidden from each other.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));

const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

describe("the composer's run-config face", () => {
  it("is hidden from md up unless the page asks for it at every width", () => {
    const composer = read("src/components/chat/Composer.tsx");
    // The gate is a prop; its default stays phone-only for any caller that
    // keeps a desktop surface of its own.
    expect(composer).toContain('footerWide ? "" : "md:hidden"');
    expect(composer).toContain("footerWide = false");
  });

  it("gives the session page one face at every width", () => {
    const source = read("src/components/task/TaskComposerDock.tsx");
    const footerAt = source.indexOf("footer={");
    expect(footerAt).toBeGreaterThan(-1);
    expect(source.indexOf("<RunConfigControl", footerAt)).toBeGreaterThan(footerAt);
    // The slot survives `md`: the face is the entry at every width.
    expect(source).toContain("footerWide");

    // No second arrangement: the strip of chips that used to face the phone
    // face, and the two controls it drew, are gone.
    expect(source).not.toContain("<PermissionModePicker");
    expect(source).not.toContain("<ModelPicker");
    expect(source).not.toContain("hidden md:flex");
  });

  it("is the new-chat page's only run control, at every width", () => {
    const source = read("src/pages/NewChatPage.tsx");
    // The draft's agent, model and mode have to be visible and changeable
    // before sending; the face is the one entry on a phone and on a Mac.
    const footerAt = source.indexOf("footer={");
    expect(footerAt).toBeGreaterThan(-1);
    expect(source.indexOf("<RunConfigControl", footerAt)).toBeGreaterThan(footerAt);
    expect(source.indexOf("footerWide", footerAt)).toBeGreaterThan(footerAt);
    // The face's settings surface still carries the run-shape rows (role,
    // branch, dispatch, routine); the machine and the project moved out to the
    // place row under the card.
    expect(source.indexOf("extraRows=")).toBeGreaterThan(footerAt);
    // ...and no second arrangement below the composer: no desktop strip, no
    // second open-state flag.
    expect(source).not.toContain("desktopStrip");
    expect(source).not.toContain("md:flex items-center gap-x-2");
    expect(source.indexOf("setControlsOpen")).toBe(-1);
  });

  it("sizes every run-settings tap target by pointer, not by viewport", () => {
    // TASTE 11: every tappable thing on a phone is at least 44px. The old
    // shrink was `sm:min-h-7` / `sm:h-[26px]` — a viewport rule — and an iPad
    // is ≥640px wide with a coarse pointer, so the same touch panel rendered
    // at Mac size. The shrink now lives behind `useCoarsePointer`; no raw
    // viewport shrink may remain in the files that own these rows.
    const files = [
      "src/components/chat/DispatchSelector.tsx",
      "src/components/chat/RunConfigSheet.tsx",
      "src/pages/NewChatPage.tsx",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, `${file} asks the pointer`).toContain("useCoarsePointer");
      expect(source, `${file} has no viewport tap-size shrink`).not.toMatch(
        /sm:(?:min-h-7|min-h-0|min-w-0|h-\[26px\]|w-\[26px\])/,
      );
    }
  });

  it("puts the machine and the project in one row under the card", () => {
    const source = read("src/pages/NewChatPage.tsx");
    // One card, then the place row. The project summary (when there is one)
    // follows the row, never between the card and the place.
    const composerAt = source.indexOf("<Composer");
    const placeAt = source.indexOf("<PlacePicker");
    expect(composerAt).toBeGreaterThan(-1);
    expect(placeAt).toBeGreaterThan(composerAt);
    expect(source.indexOf("<ProjectSummaryCard", placeAt)).toBeGreaterThan(placeAt);

    // Neither the folder browser nor the machine select is a row in the run
    // surface any more; the place row is their only home on this page.
    expect(source).not.toContain('renderControl("cwd")');
    expect(source).not.toContain('renderControl("machine")');
    const extras = source.match(/const sheetExtraRows =[\s\S]*?;/)?.[0] ?? "";
    expect(extras).not.toBe("");
    expect(extras).not.toContain('"machine"');
    expect(extras).not.toContain('"cwd"');
    for (const id of ['"branch"', '"dispatch"', '"routine"']) {
      expect(extras).toContain(id);
    }
  });
});
