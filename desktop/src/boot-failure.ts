/**
 * What the shell says when the daemon never arrives.
 *
 * The handshake already knows why a launch failed, but its reason is
 * diagnostic text — it can carry a binary path or a port — and the launch
 * surface renders in a page. This module turns that text into one of four
 * classes and then into one sentence per language, so nothing free-form ever
 * reaches the window. Pure by construction: no electron, no clock, no I/O.
 */

export type FailureReason = "rival" | "missing" | "crash" | "unknown";

export type FailureCopy = {
  /** What happened, in one sentence. */
  state: string;
  /** What the person can do about it. */
  action: string;
};

/**
 * Classify the handshake's reason without passing it on.
 *
 * Rivalry is checked first: the sidecar's stuck-rival message also says the
 * process is "not answering", which would otherwise read as a crash. Missing
 * comes next because a spawn failure for a missing binary often carries
 * ENOENT. Everything unrecognised is "unknown", never the raw text.
 */
export function reasonFrom(text: string | null | undefined): FailureReason {
  const reason = (text ?? "").toLowerCase();
  if (/rival|port|address already in use|eaddrinuse|not starting a second/.test(reason)) {
    return "rival";
  }
  if (/missing|not found|enoent/.test(reason)) return "missing";
  if (/timeout|timed out|timedout|did not become healthy|never answered|not answering/.test(reason)) {
    return "crash";
  }
  return "unknown";
}

/** The one outcome of `retryWhileUnavailable` worth telling the window about. */
export function retryOutcomeEffect(
  outcome: "ready" | "resolved" | "gave-up",
): "recovered" | "none" | "failed" {
  if (outcome === "ready") return "recovered";
  if (outcome === "gave-up") return "failed";
  return "none";
}

/** The tray item's label (`desktop/src/tray.ts`); one action for every reason. */
const ACTION_ZH = "重启 Kin，或在菜单栏的 Kin 菜单里点 Start daemon。";
const ACTION_EN = "Restart Kin, or choose Start daemon from the Kin menu in the menu bar.";

const STATE_ZH: Record<FailureReason, string> = {
  rival: "另一个 Kin 守护进程占用了端口。",
  missing: "这台机器上没有找到 Kin 守护进程。",
  crash: "Kin 守护进程启动后没有响应。",
  unknown: "Kin 守护进程没有启动。",
};

const STATE_EN: Record<FailureReason, string> = {
  rival: "Another Kin daemon is holding the port.",
  missing: "No Kin daemon was found on this machine.",
  crash: "The Kin daemon started but never answered.",
  unknown: "The Kin daemon did not start.",
};

/** The language a copy call will write; the page sets its `lang` from this. */
export type FailureLocale = "en" | "zh-Hans";

/**
 * English only when the OS locale says so; every other locale gets the
 * product's default, zh-Hans. Shared by the copy and by the page's `lang`
 * attribute, or English lines would be announced with a Chinese voice.
 */
export function failureLocale(locale: string | null | undefined): FailureLocale {
  return typeof locale === "string" && locale.toLowerCase().startsWith("en")
    ? "en"
    : "zh-Hans";
}

/** Both languages land together (TASTE 10). */
export function failureCopy(
  locale: string | null | undefined,
  reason: FailureReason,
): FailureCopy {
  if (failureLocale(locale) === "en") return { state: STATE_EN[reason], action: ACTION_EN };
  return { state: STATE_ZH[reason], action: ACTION_ZH };
}
