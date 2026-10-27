/**
 * Whether the primary pointer is precise — a mouse or a trackpad rather than a
 * finger.
 *
 * Today this decides one thing: whether a screen may focus a field on mount.
 * That is a convenience with a mouse and an ambush on a phone — the keyboard
 * covers the screen before the user has read anything, and iOS first zooms the
 * page because the field is drawn below 16px (see the touch type floor in
 * `index.css`). An environment that cannot answer is treated as precise,
 * because the only cost of guessing that way is a focused field.
 */
export function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(pointer: fine)").matches;
}
