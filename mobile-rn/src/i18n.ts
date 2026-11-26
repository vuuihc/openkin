/**
 * KIN-MOBILE-001 R2b — the RN i18n adapter from ADR 0036 §2.
 *
 * Same signatures as `ui/src/i18n/index.ts` (`t`, `getLocale`, `setLocale`,
 * `subscribeLocale`) over the same signed catalogs. It adds no strings and
 * touches no browser global: the web module persists the locale in
 * `localStorage` and syncs tabs through `window`, which the RN bundle may not
 * reference. The catalogs are imported in place; the default locale is `zh`,
 * exactly as on the web.
 *
 * The catalogs are reached by relative path rather than the `@ui/*` alias so
 * the same module resolves under tsconfig, Metro and the jest-expo preset
 * (which does not read tsconfig `paths`).
 */

import en from "../../ui/src/i18n/locales/en";
import zh, { type MessageTree } from "../../ui/src/i18n/locales/zh";

export type Locale = "zh" | "en";

const catalogs: Record<Locale, MessageTree> = { zh, en };

export const DEFAULT_LOCALE: Locale = "zh";

let currentLocale: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  listeners.forEach((listener) => listener());
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

type Params = Record<string, string | number | undefined | null>;

/** Dot-path lookup with `{name}` interpolation. */
export function t(path: string, params?: Params): string {
  const catalog = catalogs[currentLocale] ?? catalogs.zh;
  const raw = lookup(catalog, path) ?? lookup(catalogs.zh, path) ?? path;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value == null ? "" : String(value);
  });
}

function lookup(tree: MessageTree, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = tree;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export { zh, en };
