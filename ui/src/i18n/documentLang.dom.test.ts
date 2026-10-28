// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_LANG_TAG, getLocale, setLocale } from "./index";

/**
 * The document's `lang`, which the console did not set at all.
 *
 * It was `lang="en"` in the build's HTML for a product whose only shipped
 * language is Simplified Chinese. That is not cosmetic: `lang` is what selects
 * the CJK glyph variants out of the font (under `en`, 直 and 骨 render with
 * Japanese shapes), what switches the line-breaking rules, and what a screen
 * reader speaks. The catalogue guard in `locales.test.ts` covers the template;
 * this covers the running document after a switch.
 */
describe("document language", () => {
  it("starts on the default locale's tag", () => {
    expect(getLocale()).toBe("zh");
    expect(document.documentElement.lang).toBe(DEFAULT_LANG_TAG);
  });

  it("follows a locale switch, and back", () => {
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
    setLocale("zh");
    expect(document.documentElement.lang).toBe("zh-Hans");
  });
});
