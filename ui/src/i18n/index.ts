/**
 * Lightweight i18n — no runtime deps.
 * Primary locale: zh. English catalog ready for pre-release switch.
 */
import en from "./locales/en";
import zh, { type MessageTree } from "./locales/zh";

export type Locale = "zh" | "en";

const catalogs: Record<Locale, MessageTree> = { zh, en };

const STORAGE_KEY = "kin_locale";

/** Default product language until English release switch. */
export const DEFAULT_LOCALE: Locale = "zh";

let currentLocale: Locale = readStoredLocale();
const listeners = new Set<() => void>();

function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "en" || v === "zh") return v;
  } catch {
    // ignore
  }
  return DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
  // Notify React subscribers without importing react here.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("kin:locale"));
  }
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  const onWin = () => fn();
  if (typeof window !== "undefined") {
    window.addEventListener("kin:locale", onWin);
  }
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") {
      window.removeEventListener("kin:locale", onWin);
    }
  };
}

type Params = Record<string, string | number | undefined | null>;

/** Dot-path lookup with `{name}` interpolation. */
export function t(path: string, params?: Params): string {
  const catalog = catalogs[currentLocale] ?? catalogs.zh;
  const fallback = catalogs.zh;
  const raw = lookup(catalog, path) ?? lookup(fallback, path) ?? path;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key];
    return v == null ? "" : String(v);
  });
}

function lookup(tree: MessageTree, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = tree;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

export { zh, en };
