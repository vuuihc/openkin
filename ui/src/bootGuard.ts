/**
 * The console's own boot guard: a bounded wait on the splash, one automatic
 * retry, and a way out when that retry fails too.
 *
 * The splash in `index.html` is replaced by `createRoot(...).render()` and by
 * nothing else. On 2026-11-20 a phone opening the console through the tunnel
 * got the 1.9 MB entry chunk 74 KB large and stalled: `index.html` painted, the
 * module never executed, and the wheel spun forever. No timeout, no retry, no
 * error surface — only force-quitting the app. A tunnel hiccup is not a defect,
 * but a console with no way past one is.
 *
 * This module is the second Vite entry, loaded *before* `main.tsx`. The order
 * in `index.html` is load-bearing: module scripts execute in document order, so
 * a guard placed after the entry chunk would wait for the very download it
 * exists to outlive. It imports nothing, which keeps its own chunk small
 * enough to arrive on the tunnel that stalled the big one.
 *
 * Three states, one timer: wait while the splash is up and the deadline has not
 * passed; reload once when it has; after that, replace the splash's contents
 * with the same wheel, one line, and a Reload button. The reload is remembered
 * in `sessionStorage` for {@link RELOAD_WINDOW_MS} so a broken network cannot
 * turn the console into a reload loop — the second attempt is the person's
 * decision, not the timer's.
 *
 * i18n exception: this is the one surface that runs before the i18n layer is
 * loaded, so it cannot call `t()`. The two strings live in the table below and
 * are chosen by `document.documentElement.lang` (the shell and `index.html`
 * both default it to `zh-Hans`; `i18n/index.ts` updates it on a switch). Keep
 * the table in step with the locale files by hand if either string changes.
 */

export const BOOT_DEADLINE_MS = 12_000;

/** How long a spent automatic reload suppresses the next one. */
export const RELOAD_WINDOW_MS = 30_000;

/** Session-scoped, so a fresh tab gets its own automatic retry. */
export const RELOAD_STAMP_KEY = "kin.boot.reloadAt";

export type BootVerdict = "wait" | "reload" | "manual";

/**
 * What the guard should do, given what it can see.
 *
 * `attempts` is the number of automatic reloads already spent for this
 * document chain — one when the page was opened by the guard's own reload less
 * than {@link RELOAD_WINDOW_MS} ago, zero otherwise. There is no third state:
 * after one automatic retry, the next move is the person's.
 */
export function bootVerdict(input: {
  mounted: boolean;
  elapsedMs: number;
  attempts: number;
}): BootVerdict {
  if (input.mounted) return "wait";
  if (input.elapsedMs < BOOT_DEADLINE_MS) return "wait";
  return input.attempts === 0 ? "reload" : "manual";
}

type BootStrings = { slow: string; retry: string };

const STRINGS: { zh: BootStrings; en: BootStrings } = {
  zh: { slow: "网络有点慢，请重新加载", retry: "重新加载" },
  en: { slow: "The network is slow — reload to try again.", retry: "Reload" },
};

/** The splash's two lines, by the document's language. */
export function bootStrings(lang: string | null | undefined): BootStrings {
  // The product's default locale is `zh-Hans` and `index.html` declares it, so
  // an untagged document (a test, a future shell) gets Chinese rather than the
  // wrong half of the table.
  return lang?.toLowerCase().startsWith("en") ? STRINGS.en : STRINGS.zh;
}

/** The last automatic reload in this tab, or `null` when it cannot be read. */
function readReloadStamp(storage: Storage | undefined): number | null {
  try {
    const raw = storage?.getItem(RELOAD_STAMP_KEY);
    if (raw === null || raw === undefined) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    // Storage can throw (Safari private browsing, a partitioned context); the
    // guard then behaves like a first open, which is the safe direction.
    return null;
  }
}

function writeReloadStamp(storage: Storage | undefined, at: number): void {
  try {
    storage?.setItem(RELOAD_STAMP_KEY, String(at));
  } catch {
    // Same as above: losing the stamp costs one extra automatic retry at most.
  }
}

/**
 * Replace the splash with the failure state: the same wheel, one line, and the
 * one action that can still help. The wheel element is moved rather than
 * re-created, so the failure state cannot drift from the splash it replaces.
 */
function showManual(boot: Element, reload: () => void): void {
  const doc = boot.ownerDocument;
  const strings = bootStrings(doc.documentElement.lang);

  const panel = doc.createElement("div");
  panel.className = "kin-boot-panel";
  const wheel = boot.querySelector(".kin-ios-spinner");
  if (wheel) {
    // Decorative, exactly as on the splash: the words carry the state.
    wheel.setAttribute("aria-hidden", "true");
    panel.appendChild(wheel);
  }

  const note = doc.createElement("p");
  note.className = "kin-boot-note";
  note.textContent = strings.slow;

  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "kin-boot-retry";
  retry.textContent = strings.retry;
  retry.addEventListener("click", reload);

  panel.append(note, retry);
  boot.replaceChildren(panel);
  // The splash is `aria-hidden` because it says nothing a reader needs; this
  // state does, and its button takes focus. Leaving the attribute on would put
  // the only way out inside a subtree assistive technology cannot see.
  boot.removeAttribute("aria-hidden");
  // One action on the surface: put the keyboard there so the next step is the
  // one the screen is offering, not a Tab away from it.
  retry.focus();
}

export type BootGuardOptions = {
  doc?: Document;
  now?: () => number;
  reload?: () => void;
  /** How often the guard checks; exposed only so a test need not wait. */
  tickMs?: number;
  storage?: Storage;
};

/**
 * Watch the splash until React replaces it, the deadline passes, or the guard
 * gives up. Returns a stop function; calling it is idempotent.
 *
 * The guard never touches a document whose splash is already gone: that is a
 * console that booted in time, and the healthy path must stay free of side
 * effects (no sessionStorage write, no timer left behind).
 */
export function installBootGuard(options: BootGuardOptions = {}): () => void {
  const doc = options.doc ?? document;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? 500;
  const storage =
    options.storage ?? (typeof sessionStorage === "undefined" ? undefined : sessionStorage);
  const reload = options.reload ?? (() => window.location.reload());

  const boot = doc.querySelector(".kin-boot");
  if (!boot) return () => {};

  const startedAt = now();
  const stamped = readReloadStamp(storage);
  // A document the guard itself reloaded less than the window ago is the
  // second attempt, so the next deadline belongs to the person, not the timer.
  let attempts = stamped !== null && now() - stamped < RELOAD_WINDOW_MS ? 1 : 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    // `mounted` is the handover: React replaced the splash, so the wait is over
    // and the guard has nothing left to do.
    const mounted = !doc.querySelector(".kin-boot");
    const verdict = bootVerdict({ mounted, elapsedMs: now() - startedAt, attempts });
    if (verdict === "wait") {
      if (mounted) stop();
      return;
    }
    stop();
    if (verdict === "reload") {
      attempts += 1;
      writeReloadStamp(storage, now());
      reload();
      return;
    }
    showManual(boot, reload);
  };

  timer = setInterval(tick, tickMs);
  return stop;
}

// The module script is its own entry chunk, so importing this file in the page
// means the document has arrived at the splash. A test imports the same
// functions with an empty body and wires them itself, which is why arming is
// conditioned on the splash actually being present — and why the guard never
// writes to a document that has nothing to guard.
if (typeof document !== "undefined" && document.querySelector(".kin-boot")) {
  installBootGuard();
}
