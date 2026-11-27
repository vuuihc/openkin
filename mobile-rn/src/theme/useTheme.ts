import { useColorScheme } from "react-native";
import * as tokens from "./tokens";

/**
 * KIN-MOBILE-002 R1 — the only platform-aware part of the token layer.
 *
 * `useColorScheme()` reports the phone's appearance; the hook turns it into one
 * of the two palettes. `null` and `undefined` both resolve to light, because the
 * web resolves "system" to a concrete scheme too and a screen must never be
 * handed "system" or nothing. The returned values are module constants, so
 * there is nothing to memoise: a scheme change re-renders through the
 * platform's own subscription and lands on the other constant.
 */
export function useTheme() {
  const scheme: tokens.Scheme = useColorScheme() === "dark" ? "dark" : "light";
  return {
    scheme,
    colors: tokens.palette[scheme],
    type: tokens.type,
    spacing: tokens.spacing,
    radius: tokens.radius,
  };
}
