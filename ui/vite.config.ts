/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const apiPort = process.env.KIN_PORT || "7777";
const apiTarget = `http://127.0.0.1:${apiPort}`;

// Build output lands in web/dist so go:embed (web/embed.go) can pick it up
// without wiping embed.go via emptyOutDir.
export default defineConfig({
  plugins: [react()],
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
