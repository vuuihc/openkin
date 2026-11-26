/**
 * KIN-MOBILE-001 R7 — the surface the glass chrome paints with, with no React.
 *
 * §7 立刻看到 asks for the usage sheet over a 「玻璃背景」, and the same row
 * sends the glass header/navigation bar through a native module. This module
 * is the one decision both take: a normal phone gets a blurred surface, while
 * a reader who asked iOS for reduced transparency — or any Android device —
 * keeps the opaque card those surfaces have always drawn.
 *
 * Pure on purpose: the platform query and the subscription live in
 * `GlassSurface.tsx`, so the branch can be pinned without a renderer.
 */

/** The two shapes a glass surface can take. */
export type GlassSpec =
  | { kind: "blur"; intensity: number; tint: "systemMaterial" }
  | { kind: "opaque"; color: string };

/**
 * Today's card colour, kept as the readable fallback. A sheet over a blur is
 * only legible while the reader can see it; reduced transparency is the
 * reader saying they cannot (the web sibling's near-opaque footer fallback is
 * `ui/src/components/layout/PhoneFooter.tsx`, same preference, same job).
 */
export const GLASS_FALLBACK_COLOR = "#ffffff";

/** The blur that leaves the conversation readable behind the sheet's text. */
const GLASS_INTENSITY = 60;

/**
 * Which surface to draw. `platform` is the raw `Platform.OS`, typed as a
 * string so this module never imports React Native (ADR 0036 §2: the layout
 * arithmetic and the pure policy stay shared and testable).
 */
export function glassFor(opts: {
  reduceTransparency: boolean;
  platform: string;
}): GlassSpec {
  // Reduced transparency wins over everything: it is a request for
  // legibility, not a style. Android keeps the opaque card because expo-blur's
  // fidelity there is not a promise this story makes.
  if (opts.reduceTransparency || opts.platform === "android") {
    return { kind: "opaque", color: GLASS_FALLBACK_COLOR };
  }
  return {
    kind: "blur",
    intensity: GLASS_INTENSITY,
    tint: "systemMaterial",
  };
}
