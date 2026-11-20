/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const apiPort = process.env.KIN_PORT || "7777";
const apiTarget = `http://127.0.0.1:${apiPort}`;

/** The pre-entry guard, as written in `index.html` and as built. */
const GUARD_SRC = "/src/bootGuard.ts";
const GUARD_OUT = "/assets/boot-guard.js";
const GUARD_TAG = new RegExp(
  `\\s*<script\\b[^>]*\\bsrc="${GUARD_SRC.replace(/[/.]/g, "\\$&")}"[^>]*></script>`,
);

/**
 * Keep `src/bootGuard.ts` a file of its own in the build.
 *
 * The guard's whole job is to run while a stalled tunnel is still delivering
 * the 1.9 MB console entry, so its script tag must execute first and its
 * bundle must not be the entry's. Vite folds every module script in one HTML
 * into a single virtual entry, which is exactly the failure this wiring
 * prevents: built that way, the guard is dead code behind the download it
 * exists to outlive (observed on 2026-11-20: the tag disappeared and the
 * guard's strings landed inside `index-*.js`).
 *
 * In the build, the tag is removed from the document before Vite folds the
 * scripts, `src/bootGuard.ts` is built as its own entry with a stable name,
 * and a tag for that file is put at the top of `<head>` — ahead of the entry
 * chunk, so document order runs the guard first. In dev the source tag is
 * left alone and the module is its own chunk already.
 */
function bootGuardEntry(): Plugin {
  return {
    name: "kin-boot-guard-entry",
    apply: "build",
    // The HTML plugin writes the document from its own buffer in its
    // `generateBundle`; running after it is what keeps the injected tag.
    enforce: "post",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(GUARD_TAG, ""),
    },
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (item) => item.type === "asset" && item.fileName.endsWith(".html"),
      );
      if (!html || html.type !== "asset") return;
      const tag = `<script type="module" crossorigin src="${GUARD_OUT}"></script>`;
      html.source = String(html.source).replace("<head>", `<head>\n    ${tag}`);
    },
  };
}

// Build output lands in web/dist so go:embed (web/embed.go) can pick it up
// without wiping embed.go via emptyOutDir.
export default defineConfig({
  plugins: [react(), bootGuardEntry()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // Live events over /api/ws
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../web/dist"),
    emptyOutDir: true,
    rollupOptions: {
      // Two entries: the console, and the guard that must outlive its
      // download. `strict` is what gives each one its own chunk; without it
      // Rollup may fold the export-less guard into the entry.
      input: [path.resolve(__dirname, "index.html"), path.resolve(__dirname, "src/bootGuard.ts")],
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "bootGuard" ? "assets/boot-guard.js" : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    // The environment stays node. Most of this suite is pure logic — reducers,
    // formatters, the keyboard state machine — and runs in milliseconds there.
    // A test that needs a document asks for one itself, with a
    // `// @vitest-environment jsdom` docblock at the top of the file, so the
    // cost of a DOM is paid by the files that use it and by no others.
    setupFiles: ["src/test/setup.ts"],
  },
});
