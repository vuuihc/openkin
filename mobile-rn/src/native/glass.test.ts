import { describe, expect, it } from "@jest/globals";
import { GLASS_FALLBACK, glassFor, liquidGlassFor } from "./glass";
import { palette } from "../theme/tokens";

/**
 * KIN-MOBILE-001 R7 — the glass surface's two branches, without a renderer.
 *
 * §7 立刻看到 says the usage sheet comes up over a glass background, and the
 * same row says the glass header/navigation bar goes through the native
 * module. A phone whose reader asked for reduced transparency (iOS Settings >
 * Accessibility) must not get a translucent surface it cannot read: it keeps
 * today's opaque card. Android keeps the opaque card too — expo-blur's
 * fidelity there is not a promise this story makes.
 */

describe("KIN-MOBILE-001 R7 glass surface", () => {
  it("KIN-MOBILE-001 R7: a normal phone gets the blurred glass, not the flat card", () => {
    expect(glassFor({ reduceTransparency: false, platform: "ios", scheme: "light" })).toEqual({
      kind: "blur",
      intensity: 60,
      tint: "systemMaterialLight",
    });
  });

  it("KIN-MOBILE-001 R7: the blur follows the scheme, so dark mode gets the dark material", () => {
    expect(glassFor({ reduceTransparency: false, platform: "ios", scheme: "dark" })).toEqual({
      kind: "blur",
      intensity: 60,
      tint: "systemMaterialDark",
    });
  });

  it("KIN-MOBILE-001 R7: reduce transparency keeps the sheet readable over an opaque surface", () => {
    expect(GLASS_FALLBACK.light).toBe(palette.light.elevated);
    expect(glassFor({ reduceTransparency: true, platform: "ios", scheme: "light" })).toEqual({
      kind: "opaque",
      color: GLASS_FALLBACK.light,
    });
  });

  it("KIN-MOBILE-001 R7: the dark fallback is the dark elevated card, never white", () => {
    expect(GLASS_FALLBACK.dark).toBe(palette.dark.elevated);
    expect(GLASS_FALLBACK.dark).not.toBe("#ffffff");
    expect(glassFor({ reduceTransparency: true, platform: "ios", scheme: "dark" })).toEqual({
      kind: "opaque",
      color: palette.dark.elevated,
    });
  });

  it("KIN-MOBILE-001 R7: Android keeps the opaque card", () => {
    expect(
      glassFor({ reduceTransparency: false, platform: "android", scheme: "light" }),
    ).toEqual({
      kind: "opaque",
      color: GLASS_FALLBACK.light,
    });
  });
});

/**
 * KIN-MOBILE-002 R5 — the composer's system material.
 *
 * The frame (`KIN-MOBILE-002.figma/frames/04-phone-composer-approval.svg`) and
 * DESIGN.md:39 ask for the composer capsule to use the system material on iOS.
 * iOS 26's liquid glass is that material; anything older, Android, and a reader
 * who asked for reduced transparency must fall back to the surface those
 * phones already draw — the same blur/opaque table the header uses.
 */
describe("KIN-MOBILE-002 R5 compositor glass", () => {
  it("KIN-MOBILE-002 R5: iOS 26 draws the composer with the liquid glass material", () => {
    expect(
      liquidGlassFor({
        reduceTransparency: false,
        platform: "ios",
        version: "26.0",
        scheme: "light",
      }),
    ).toEqual({ kind: "liquid" });
  });

  it("KIN-MOBILE-002 R5: iOS 25 falls back to the blur, not the opaque card", () => {
    expect(
      liquidGlassFor({
        reduceTransparency: false,
        platform: "ios",
        version: "25.6",
        scheme: "dark",
      }),
    ).toEqual({
      kind: "blur",
      intensity: 60,
      tint: "systemMaterialDark",
    });
  });

  it("KIN-MOBILE-002 R5: reduced transparency wins over liquid glass", () => {
    expect(
      liquidGlassFor({
        reduceTransparency: true,
        platform: "ios",
        version: "26.1",
        scheme: "light",
      }),
    ).toEqual({ kind: "opaque", color: GLASS_FALLBACK.light });
  });
});
