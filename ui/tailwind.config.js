/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0f1115",
          raised: "#161a22",
          border: "#2a3140",
        },
        accent: {
          DEFAULT: "#6ee7b7",
          muted: "#34d399",
        },
      },
    },
  },
  plugins: [],
};
