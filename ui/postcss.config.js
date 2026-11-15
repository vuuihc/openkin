export default {
  plugins: {
    // Tailwind 4 integrates through its own PostCSS package. Autoprefixer stays
    // after it for the stylesheet's non-Tailwind rules (the Ionic sheet's
    // platform selectors and the `-webkit-` mask fallbacks), which Tailwind's
    // Lightning CSS pass does not own.
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
