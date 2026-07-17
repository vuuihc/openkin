import { useSyncExternalStore } from "react";
import {
  getLocale,
  setLocale,
  subscribeLocale,
  t as translate,
  type Locale,
} from "./index";

/** Re-render when locale changes. */
export function useLocale(): {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: typeof translate;
} {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return { locale, setLocale, t: translate };
}

/** Convenience: just the translator bound to current locale. */
export function useT(): typeof translate {
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return translate;
}
