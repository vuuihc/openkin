/**
 * The type ladder — seven roles, and the only place a font size is written.
 *
 * `tailwind.config.ts` turns this into `theme.fontSize` (assignment, not
 * `extend`: the old names must stop existing, so a stray default size utility
 * emits nothing at all, and the leftover-size guard in `tokens.test.ts` fails).
 * The gallery renders the same array, so a role cannot be added here without
 * appearing on `/design`.
 *
 * `px` is the size. `weight` and `ink` are the *role's default* — what the role
 * looks like when the element says nothing — not something injected into every
 * element that uses it: those elements already carry their own
 * `font-*`/`text-kin-*` classes and a second declaration would be resolved by
 * CSS order, not by intent. So a `text-strong font-semibold` is normal: the
 * ladder sets the size, the element sets the emphasis. What the pair must do is
 * stay tellable apart — the guard rejects two roles that share a
 * `(px, weight, ink)`, and any two adjacent roles that differ only in size,
 * because 12px and 13px at the same weight and ink are the same step twice.
 *
 * `absorbed` records which sizes the role replaced, so the snap stays
 * reviewable after the arbitrary values are gone. An entry ending in `px` is a
 * literal size; anything else is a name from Tailwind's default scale, written
 * without its prefix — this tree is not allowed to contain one, so the data
 * cannot spell it out and the gallery adds the prefix when it renders.
 */
export type TypeRole = {
  role: string;
  px: number;
  /** 400 regular · 500 medium · 600 semibold · 700 bold */
  weight: 400 | 500 | 600 | 700;
  /** Ink token name; the class is `text-kin-<ink>`. */
  ink: "text" | "secondary" | "muted";
  absorbed: string[];
};

export const TYPE_ROLES: TypeRole[] = [
  { role: "micro", px: 11, weight: 600, ink: "muted", absorbed: ["8px", "9px", "10px"] },
  {
    role: "caption",
    px: 12,
    weight: 400,
    ink: "secondary",
    absorbed: ["10.5px", "11px", "11.5px"],
  },
  {
    role: "body",
    px: 13,
    weight: 400,
    ink: "text",
    absorbed: ["xs", "12px", "12.5px"],
  },
  {
    role: "strong",
    px: 14,
    weight: 500,
    ink: "text",
    absorbed: ["13px", "13.5px", "14px", "sm"],
  },
  { role: "subtitle", px: 16, weight: 600, ink: "text", absorbed: ["14.5px", "15px", "16px"] },
  { role: "title", px: 18, weight: 600, ink: "text", absorbed: ["17px", "lg"] },
  {
    role: "hero",
    px: 24,
    weight: 700,
    ink: "text",
    absorbed: ["xl", "2xl", "22px", "28px", "32px"],
  },
  // The phone landing screen's title. It is one step above `hero` and one
  // weight below it: a page's h1 on a 390pt screen wants to be *larger* than
  // the desktop step, but bold at that size reads as a marketing headline
  // rather than as the name of the screen. Semibold at 28px is what iOS large
  // titles and Lody's landing both use.
  { role: "display", px: 28, weight: 600, ink: "text", absorbed: [] },
];

/** What `tailwind.config.ts` assigns to `theme.fontSize`. */
export const FONT_SIZE: Record<string, string> = Object.fromEntries(
  TYPE_ROLES.map((r) => [r.role, `${r.px}px`]),
);

/** Weight number → the Tailwind class the gallery must render it with. */
export const WEIGHT_CLASS: Record<number, string> = {
  400: "font-normal",
  500: "font-medium",
  600: "font-semibold",
  700: "font-bold",
};

/**
 * The literal classes each role is previewed with.
 *
 * Tailwind only sees class names that appear verbatim in the source, so this
 * cannot be built by interpolation. The guard derives the expected string from
 * `TYPE_ROLES` and fails if an entry disagrees, so the duplication cannot rot.
 */
export const ROLE_PREVIEW: Record<string, string> = {
  micro: "text-micro font-semibold text-kin-muted",
  caption: "text-caption font-normal text-kin-secondary",
  body: "text-body font-normal text-kin-text",
  strong: "text-strong font-medium text-kin-text",
  subtitle: "text-subtitle font-semibold text-kin-text",
  title: "text-title font-semibold text-kin-text",
  hero: "text-hero font-bold text-kin-text",
  display: "text-display font-semibold text-kin-text",
};
