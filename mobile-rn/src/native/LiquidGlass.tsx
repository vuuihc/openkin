/**
 * KIN-MOBILE-002 R5 — the composer's liquid glass, drawn by the system.
 *
 * iOS 26 ships the liquid glass material (`expo-glass-effect`, pinned by ADR
 * 0036), and the composer capsule is the one surface that asks for it
 * (DESIGN.md:39: glass only for bars floating over scrolled content, using the
 * system material). This file is separate from `GlassSurface.tsx` on purpose:
 * it is the only module that imports the native view, and `GlassSurface` loads
 * it lazily on the liquid branch, so the chrome suites that render the header
 * and the usage sheet never pull the native module into jest.
 *
 * No colour, radius or size lives here: the capsule's own style is the caller's
 * (`StyleSheet.absoluteFill`), and the material is the platform's.
 */

import { GlassView } from "expo-glass-effect";
import type { StyleProp, ViewStyle } from "react-native";

export type LiquidGlassProps = {
  /** Where the layer sits; the capsule clips it to its own radius. */
  style?: StyleProp<ViewStyle>;
};

export default function LiquidGlass({ style }: LiquidGlassProps) {
  return (
    <GlassView
      glassEffectStyle="regular"
      style={style}
      testID="glass-liquid"
    />
  );
}
