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
import { glassFor } from "./glass";

export type GlassSurfaceProps = {
  /**
   * Where the layer sits. The sheet passes `StyleSheet.absoluteFill` so the
   * surface covers the card behind the content; the layer has no size of its
   * own and no other prop to explain.
   */
  style?: StyleProp<ViewStyle>;
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

export default function GlassSurface({ style }: GlassSurfaceProps) {
  const spec = glassFor({
    reduceTransparency: useReduceTransparency(),
    platform: Platform.OS,
  });

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
