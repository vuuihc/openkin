/** Map backend cancel/timeout tokens (and raw stream cancel noise) to i18n copy. */

/** True for abort/cancel tokens that are not real task failures (e.g. steer interrupt). */
export function isCancelNoise(message: string | null | undefined): boolean {
  const s = (message ?? "").trim().toLowerCase();
  if (!s) return false;
  return (
    s === "canceled" ||
    s === "cancelled" ||
    s === "context canceled" ||
    s === "context cancelled" ||
    (s.includes("stream error") && s.includes("cancel")) ||
    (s.includes("cancel") && s.includes("received from peer"))
  );
}

export function friendlyErrorLabel(
  message: string,
  tr: (key: string) => string,
): string {
  const raw = (message ?? "").trim();
  if (isCancelNoise(raw)) {
    return tr("chat.canceled");
  }
  const s = raw.toLowerCase();
  if (
    s === "timed out" ||
    s === "timeout" ||
    s === "context deadline exceeded"
  ) {
    return tr("chat.timedOut");
  }
  return raw || "error";
}
