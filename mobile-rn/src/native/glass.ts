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

import { palette, type Scheme } from "../theme/tokens";

/** The two shapes a glass surface can take. */
export type GlassSpec =
  | {
      kind: "blur";
      intensity: number;
      tint: "systemMaterialLight" | "systemMaterialDark";
    }
  | { kind: "opaque"; color: string };

/**
 * The readable fallback card, per scheme. A sheet over a blur is only legible
 * while the reader can see it; reduced transparency is the reader saying they
 * cannot (the web sibling's near-opaque footer fallback is
 * `ui/src/components/layout/PhoneFooter.tsx`, same preference, same job). It
 * follows the scheme so dark mode gets the elevated dark card, not a white
 * one — white cards in the dark were the bug R1b exists to fix.
 */
export const GLASS_FALLBACK: Record<Scheme, string> = {
  light: palette.light.elevated,
  dark: palette.dark.elevated,
};

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
  scheme: Scheme;
}): GlassSpec {
  // Reduced transparency wins over everything: it is a request for
  // legibility, not a style. Android keeps the opaque card because expo-blur's
  // fidelity there is not a promise this story makes.
  if (opts.reduceTransparency || opts.platform === "android") {
    return { kind: "opaque", color: GLASS_FALLBACK[opts.scheme] };
  }
  return {
    kind: "blur",
    intensity: GLASS_INTENSITY,
    // The blur's material follows the scheme: a light material over a dark
    // conversation washes the text behind it white again.
    tint: opts.scheme === "dark" ? "systemMaterialDark" : "systemMaterialLight",
  };
}
