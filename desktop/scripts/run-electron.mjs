/**
 * Launch Electron with a clean env.
 *
 * IDE agent shells (and some tooling) set ELECTRON_RUN_AS_NODE=1, which makes
 * `require("electron")` return the binary path string instead of the API —
 * the main process then crashes on app.requestSingleInstanceLock().
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const electronBin = require("electron");

const env = { ...process.env };
// Critical: must not run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
// Avoid inheriting "already packaged" lies from host IDEs.
delete env.ELECTRON_FORCE_IS_PACKAGED;

const child = spawn(electronBin, ["."], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
