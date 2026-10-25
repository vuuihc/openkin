import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rules the phone block has to keep, as source.
 *
 * Source rather than DOM, like `zen.test.ts`: the tree has no DOM test
 * environment by design, and both claims below are about *what the code does
 * not do* — which is exactly the kind of thing a later "small improvement"
 * re-adds without noticing. Neither is a rendering detail.
 */
const UI = fileURLToPath(new URL("../../..", import.meta.url));

const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

describe("the phone block in settings", () => {
  it("does not put a connection QR on a passive settings tab", () => {
    // `connect_url` carries a token and is served only to a master request, and
    // the connection QR encodes it. It lives on the Remote tab, where asking for
    // it is the point of the screen. A second copy on General would draw a
    // credential onto whatever is on screen whenever settings is opened — and on
    // the phone itself it would render empty, because a paired device is not a
    // master request. The block links to the QR instead.
    const source = read("src/components/settings/PhoneSection.tsx");
    expect(source).not.toMatch(/qrcode\.react|QRCode/);
    expect(source).toMatch(/onOpenTab\("remote"\)/);
  });

  it("shows the saved base URL, not the unsaved draft in the field", () => {
    // The draft in `ui.base_url`'s input is local state until Save. Pushes use
    // what is stored, so a block that read the draft would promise a landing
    // address the phone cannot reach yet.
    const page = read("src/pages/SettingsPage.tsx");
    const call = page.slice(
      page.indexOf("<PhoneSection"),
      page.indexOf("/>", page.indexOf("<PhoneSection")),
    );
    expect(call).toMatch(/baseUrl=\{settings\["ui\.base_url"\]/);
    expect(call).not.toMatch(/baseUrl=\{baseURL\}/);
  });
});
