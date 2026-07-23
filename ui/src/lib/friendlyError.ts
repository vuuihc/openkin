/** Map backend cancel/timeout tokens (and raw stream cancel noise) to i18n copy. */
export function friendlyErrorLabel(
  message: string,
  tr: (key: string) => string,
): string {
  const raw = (message ?? "").trim();
  const s = raw.toLowerCase();
  if (
    s === "canceled" ||
    s === "cancelled" ||
    s === "context canceled" ||
    s === "context cancelled" ||
    (s.includes("stream error") && s.includes("cancel")) ||
    (s.includes("cancel") && s.includes("received from peer"))
  ) {
    return tr("chat.canceled");
  }
  if (
    s === "timed out" ||
    s === "timeout" ||
    s === "context deadline exceeded"
  ) {
    return tr("chat.timedOut");
  }
  return raw || "error";
}
