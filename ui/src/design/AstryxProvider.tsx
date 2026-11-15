/**
 * The one place Astryx is mounted.
 *
 * Astryx components need three things from the console that Kin already owns:
 * the resolved colour scheme, the locale, and the theme tokens. This provider
 * reads the first two from where Kin already keeps them and hands them to
 * Astryx; it adds no layout box of its own and changes no page. (Astryx's
 * `Theme` renders a `display: contents` wrapper, so it contributes a DOM node
 * but no box. Its prose defaults are neutralised in `index.css`.)
 *
 * The scheme comes from `<html data-theme>`, not from a second copy of the
 * preference. `applyTheme()` already resolves "system" to `light`/`dark` and
 * writes it there, so watching that attribute is the same signal Tailwind's
 * `dark:` variant uses — there is one answer to "which scheme is in force".
 * Astryx's `Theme` maps it back to `color-scheme` through its reset, which is
 * what makes native controls, scrollbars and `light-dark()` follow.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { InternationalizationProvider, Theme } from "@astryxdesign/core";
import zhCN from "@astryxdesign/core/locales/zh-CN.generated.js";
import { useLocale } from "../i18n/react";
import { astryxLocaleFor, kinAstryxTheme } from "./astryxTheme";

type Scheme = "light" | "dark";

/**
 * The scheme Kin has in force.
 *
 * `applyTheme()` writes `data-theme` on every change and always writes a
 * resolved value, so an absent attribute only means the document is not up yet
 * (a test, or the first paint before `initTheme()` ran); dark is the product
 * default and matches the stylesheet's default block.
 */
function readScheme(): Scheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function subscribeScheme(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * Wrap the console in the Astryx theme and its i18n context.
 *
 * Locale is read through Kin's `useLocale`, so an in-app language change
 * reaches Astryx components without a reload. The messages are Astryx's own
 * shipped catalog for that locale: these are its component strings (a dialog's
 * close label, a list's empty state), not product copy Kin translates. Kin's
 * catalog stays the only source for Kin's own words.
 */
export function AstryxProvider({ children }: { children: ReactNode }): ReactNode {
  const scheme = useSyncExternalStore(subscribeScheme, readScheme, () => "dark" as const);
  const { locale } = useLocale();
  const astryxLocale = astryxLocaleFor(locale);
  return (
    <Theme theme={kinAstryxTheme} mode={scheme}>
      <InternationalizationProvider
        locale={astryxLocale}
        messages={astryxLocale === "zh-CN" ? { "zh-CN": zhCN } : undefined}
      >
        {children}
      </InternationalizationProvider>
    </Theme>
  );
}
