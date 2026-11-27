/**
 * KIN-MOBILE-001 R7 — the one surface that draws the glass.
 *
 * The sheet asks for a background layer and gets either the native blur
 * (`expo-blur`, pinned by ADR 0036:167) or today's opaque white. The branch
 * itself is `glassFor` (`./glass.ts`); this file owns the platform read and
 * the subscription only.
 *
 * The preference arrives asynchronously, so the surface starts on the
 * platform default (no reduction) and swaps when the answer lands. An answer
 * that arrives after unmount — the sheet closed while iOS was still
 * answering — is dropped (AGENTS.md §11). `useReduceTransparency` is exported
 * because the card that hosts the layer needs the same branch for its own
 * background: one query, one subscription per reader of it.
 */

import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";
import { glassFor, liquidGlassFor, type GlassSpec } from "./glass";
import { useTheme } from "../theme/useTheme";

export type GlassSurfaceProps = {
  /**
   * Where the layer sits. The sheet passes `StyleSheet.absoluteFill` so the
   * surface covers the card behind the content; the layer has no size of its
   * own and no other prop to explain.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * Which surface this layer backs. The chrome (header, usage sheet) keeps the
   * blur it shipped with; the composer asks for the system's liquid glass on
   * iOS 26 (`liquidGlassFor`, KIN-MOBILE-002 R5) and falls back to the same
   * blur/opaque table everywhere else.
   */
  material?: "chrome" | "composer";
};

/**
 * The reader's reduced-transparency preference. Starts at the platform
 * default (`false`) rather than at a guess about the device: iOS reports the
 * real value in the first async answer.
 */
export function useReduceTransparency(): boolean {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    // The surface may unmount before the platform answers (a fast open/close),
    // so every answer is checked against this mount before it is applied.
    let current = true;

    const answer = AccessibilityInfo.isReduceTransparencyEnabled?.();
    answer
      ?.then((enabled) => {
        if (current) setReduceTransparency(enabled);
      })
      .catch(() => {
        // A platform that cannot answer keeps the default surface instead of
        // rejecting into the sheet.
      });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (enabled: boolean) => {
        if (current) setReduceTransparency(enabled);
      },
    );

    return () => {
      current = false;
      subscription?.remove?.();
    };
  }, []);

  return reduceTransparency;
}

/**
 * Metro's `require`, declared for the one lazy import below: the type-level
 * module graph still knows `LiquidGlass` (`typeof import`), while the runtime
 * loads it only on the branch that draws it. The header and usage-sheet suites
 * render this file without ever pulling the native module into jest.
 */
declare const require: (id: string) => unknown;

function loadLiquidGlass(): typeof import("./LiquidGlass").default {
  const loaded = require("./LiquidGlass") as {
    default: typeof import("./LiquidGlass").default;
  };
  return loaded.default;
}

export default function GlassSurface({
  style,
  material = "chrome",
}: GlassSurfaceProps) {
  const { scheme } = useTheme();
  const reduceTransparency = useReduceTransparency();
  const spec: GlassSpec =
    material === "composer"
      ? liquidGlassFor({
          reduceTransparency,
          platform: Platform.OS,
          version: Platform.Version,
          scheme,
        })
      : glassFor({ reduceTransparency, platform: Platform.OS, scheme });

  if (spec.kind === "liquid") {
    const LiquidGlass = loadLiquidGlass();
    return <LiquidGlass style={style} />;
  }

  if (spec.kind === "blur") {
    return (
      <BlurView
        intensity={spec.intensity}
        style={style}
        testID="glass-blur"
        tint={spec.tint}
      />
    );
  }

  return (
    <View
      style={[style, { backgroundColor: spec.color }]}
      testID="glass-opaque"
    />
  );
}
