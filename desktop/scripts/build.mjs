import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist");
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(outdir, "main.js"),
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});

console.log("desktop: bundled → dist/main.js");
