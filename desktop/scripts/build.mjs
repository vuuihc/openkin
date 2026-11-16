import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist");
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(outdir, "main.js"),
});

// Preload must be a separate file (loaded into the renderer sandbox).
await esbuild.build({
  ...common,
  entryPoints: [join(root, "src/preload.ts")],
  outfile: join(outdir, "preload.js"),
});

console.log("desktop: bundled → dist/main.js + dist/preload.js");
