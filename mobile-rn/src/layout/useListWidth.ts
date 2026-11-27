import { useWindowDimensions } from "react-native";

/**
 * KIN-MOBILE-001 R3 — the one place the routes read the window width.
 *
 * `useWindowDimensions` re-renders on rotation and on a desktop window resize,
 * so the split decision is re-asked instead of frozen at mount. Kept behind a
 * named hook so route tests can pin the width without mocking React Native.
 */
export function useListWidth(): number {
  return useWindowDimensions().width;
}
