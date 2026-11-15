# Astryx bridge (F3)

Status: installed, not yet used by any page. `AstryxProvider` wraps the app;
no component is migrated yet, so the console looks and behaves exactly as it did
before this slice.

## What is installed and where it mounts

| Package | Version | Why |
|---|---|---|
| `@astryxdesign/core` | 0.7.16 | Components, `Theme`, `defineTheme`, `InternationalizationProvider` |
| `@astryxdesign/theme-neutral` | 0.7.16 | The base theme `defineTheme` extends |
| `@stylexjs/stylex` | 0.19.2 | Runtime peer of Astryx's pre-compiled StyleX CSS |

`ui/src/main.tsx` renders `<AstryxProvider>` inside `StrictMode`, around
`BrowserRouter`. The Provider renders no DOM: it mounts Astryx's `Theme` and
`InternationalizationProvider` and hands them the values Kin already owns.

`ui/src/index.css` imports `@astryxdesign/core/reset.css` and
`@astryxdesign/core/astryx.css` after `tailwindcss`. The cascade order is the
one declared at the top of that file:

```
reset, theme, base, astryx-base, astryx-theme, components, utilities
```

`reset` is first so Astryx's reset sits below Tailwind's preflight (`base`), and
`astryx-base`/`astryx-theme` sit below Tailwind utilities. Every Astryx
stylesheet re-declares the same order, so load order between the files cannot
change it.

The theme's own generated CSS is injected at runtime by `Theme` (unbuilt
theme). It warns once in development and costs a `<style>` write on first
mount. Pre-building it with `npx @astryxdesign/cli theme build` is a later
optimisation, deliberately not done here: the token map is expected to grow as
the facade slices (F5a–F5e) meet real components.

## The token map

`ui/src/design/astryxTheme.ts` holds `KIN_TOKEN_BINDINGS`: one entry per token
in `ui/src/design/colors.ts`. An entry either lists the Astryx token names that
take the Kin value, or records why the token stays a Kin extension.

Values are references, never copies: a mapped token is written as
`var(--kin-text)` or `rgb(var(--kin-blue-rgb) / 1)`, using the same `cssValue`
helper as the call sites. `design/theme.css` remains the only file with a colour
in it.

Mapped (semantic slots):

| Kin | Astryx |
|---|---|
| `--kin-page` / `--kin-bg` / `--kin-elevated-rgb` / `--kin-panel-rgb` | `--color-background-body` / `-surface` / `-card` / `-popover` |
| `--kin-text` / `--kin-secondary` | `--color-text-primary` + `--color-icon-primary` / `--color-text-secondary` + `--color-icon-secondary` |
| `--kin-hairline` / `--kin-hairline-strong` | `--color-border` / `--color-border-emphasized` |
| `--kin-fill` | `--color-background-muted` |
| `--kin-focus-ring` | `--focus-outline-color` |
| `--kin-blue-rgb` / `-orange-` / `-green-` / `-red-` | `--color-accent` + `--color-info` / `--color-warning` / `--color-success` / `--color-error` |
| `--kin-*-ink-rgb` | `--color-text-*` and `--color-icon-*` for the same status |
| `--kin-on-status` / `--kin-on-brand` | `--color-on-{success,warning,error}` / `--color-on-{accent,info}` |

Kin extensions (Astryx has no slot with that meaning; the facade reads the Kin
name directly): the three surfaces not on Astryx's ladder (`--kin-sidebar`,
`--kin-inspector`), the third ink step (`--kin-muted-rgb`), the stronger wash
(`--kin-fill-strong`), the seven agent identity marks, the user bubble, and the
three elevation colours (Astryx shadows are complete `box-shadow` values, so a
colour cannot be written into them).

`astryxTheme.test.ts` fails when a Kin token has neither a mapping nor an
extension reason, when a mapping names something that is not an Astryx core
token, when one Astryx token is written by two Kin tokens, or when the mapped
value is not the Kin custom property.

Astryx tokens without a Kin mapping keep the neutral theme's value. They are
added when a component that needs them lands, not speculatively: a mapping is a
colour decision and belongs on a screen.

## Provider behaviour

- **Scheme.** Reads `<html data-theme>` (`light`/`dark`) with
  `useSyncExternalStore` + a `MutationObserver`, and passes it to `Theme`.
  This is the same signal Tailwind's `dark:` variant uses, so there is no second
  copy of the preference. Astryx's reset maps `data-theme` to `color-scheme`,
  which is what makes native controls, scrollbars and `light-dark()` follow the
  console's theme.
- **Locale.** Reads Kin's `useLocale` and maps `zh → zh-CN`, `en → en`. The
  `zh-CN` runtime catalog is passed to `InternationalizationProvider`; `en` is
  bundled by Astryx. These catalogs hold Astryx's own component strings (a
  dialog's close label, an empty state), not Kin's product copy — those stay in
  `ui/src/i18n`.
- **Touch floor.** One theme adaptation rule, `when: { pointer: 'coarse' }`,
  writes `--size-element-sm/md/lg: 44px`. Astryx sizes every control through
  those three tokens as `min-height`, so the floor applies to whatever the
  facade renders. Kin's own buttons keep their existing floor in `index.css`.
  Note the deliberate difference: Kin's floor also has a narrow-viewport arm;
  the Astryx rule applies to any coarse pointer, tablets included.
- **Reduced motion.** Astryx already follows `prefers-reduced-motion` (52
  guarded blocks in `astryx.css` plus its animator), so the bridge adds no
  duplicate rule. The theme pins `motion: { tempo: 1, character: 'standard' }`
  — Kin's motion is Astryx's default, not an upstream default that can drift.
  The test holds the imported stylesheet to still carrying the guards.

## Known gaps

- No component is migrated. The facade slices (F5a–F5e) are the first callers;
  until then this is a mounted, tested bridge with no visual surface.
- Astryx's runtime theme injection is a development-time cost. Pre-build the
  theme when the map stops moving.
- Astryx ships `zh-CN`/`zh-TW`, not a script tag (`zh-Hans`). Kin's locale is
  mapped to the region tag; if a future locale needs a script-only tag, add the
  catalog under that tag rather than changing the resolver.
