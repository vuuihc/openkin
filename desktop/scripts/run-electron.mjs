/**
 * Launch Electron with a clean env + macOS app branding.
 *
 * IDE agent shells (and some tooling) set ELECTRON_RUN_AS_NODE=1, which makes
 * `require("electron")` return the binary path string instead of the API —
 * the main process then crashes on app.requestSingleInstanceLock().
 *
 * On macOS, Dock title/icon come from Electron.app's Info.plist — we rebrand
 * that bundle in node_modules before spawn (see brand-electron-app.mjs).
 *
 * Dev restarts: kill any previous instance of THIS project's Kin.app so
 * `npm run dev` doesn't flash and exit on single-instance lock.
 *
 * macOS caveat: branded main process argv is just "Kin" (no full path), so
 * `pgrep -f .../MacOS/Kin` misses it. We use `lsof -t <binary>` instead.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandElectronApp } from "./brand-electron-app.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const electronBin = brandElectronApp(require("electron"), root);

function collectPidsFrom(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of out.split(/\s+/)) {
      const n = Number(line.trim());
      if (Number.isFinite(n) && n > 0 && n !== process.pid) pids.add(n);
    }
    return pids;
  } catch {
    return new Set();
  }
}

/** Kill leftover dev Kin processes for this repo (not /Applications/Kin). */
function stopPreviousDevInstances() {
  const markers = [
    join(root, "node_modules/electron/dist/Kin.app/Contents/MacOS/Kin"),
    join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    join(root, ".dev-app/Kin.app/Contents/MacOS/Kin"),
  ];

  const pids = new Set();

  // 1) lsof on the executable path — finds main process when argv is just "Kin".
  for (const marker of markers) {
    if (!existsSync(marker)) continue;
    for (const pid of collectPidsFrom("lsof", ["-t", marker])) {
      pids.add(pid);
    }
  }

  // 2) Processes named "Kin" with cwd under this desktop/ (orphans, ppid=1).
  for (const pid of collectPidsFrom("pgrep", ["-x", "Kin"])) {
    try {
      const out = execFileSync(
        "lsof",
        ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const cwdLine = out.split("\n").find((l) => l.startsWith("n"));
      const cwd = cwdLine ? cwdLine.slice(1) : "";
      if (cwd === root || cwd.startsWith(root + "/")) {
        pids.add(pid);
      }
    } catch {
      /* ignore */
    }
  }

  // 3) Helpers / launchers that still expose our paths in argv.
  for (const marker of markers) {
    for (const pid of collectPidsFrom("pgrep", ["-f", marker])) {
      pids.add(pid);
    }
  }
  for (const pid of collectPidsFrom("pgrep", [
    "-f",
    `${root}/node_modules/electron/dist/`,
  ])) {
    pids.add(pid);
  }
  for (const pid of collectPidsFrom("pgrep", [
    "-f",
    `app-path=${root}`,
  ])) {
    pids.add(pid);
  }

  if (pids.size === 0) return;

  console.log(
    `[kin-desktop] stopping previous dev instance(s): ${[...pids].join(", ")}`,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Brief wait, then force.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    let alive = false;
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        pids.delete(pid);
      }
    }
    if (!alive) break;
    try {
      execFileSync("sleep", ["0.05"]);
    } catch {
      /* ignore */
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }

  // Helpers sometimes outlive main; sweep again by dist path.
  const leftovers = collectPidsFrom("pgrep", [
    "-f",
    `${root}/node_modules/electron/dist/`,
  ]);
  for (const pid of leftovers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/** Remove Chromium SingletonLock if the holder PID is dead. */
function clearStaleSingletonLocks() {
  const dirs = [
    join(homedir(), "Library/Application Support/Kin"),
    join(homedir(), "Library/Application Support/Kin-dev"),
    join(homedir(), "Library/Application Support/kin-desktop"),
  ];
  for (const dir of dirs) {
    const lock = join(dir, "SingletonLock");
    if (!existsSync(lock)) continue;
    let dead = false;
    try {
      if (lstatSync(lock).isSymbolicLink()) {
        const target = readlinkSync(lock); // e.g. hostname-12345
        const m = /-(\d+)$/.exec(target);
        if (m) {
          const pid = Number(m[1]);
          try {
            process.kill(pid, 0);
            // holder alive — leave lock (unless we just killed it)
          } catch {
            dead = true;
          }
        } else {
          dead = true;
        }
      }
    } catch {
      dead = true;
    }
    if (!dead) continue;
    for (const name of [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
    ]) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* ignore */
      }
    }
    console.log(`[kin-desktop] cleared stale singleton lock in ${dir}`);
  }
}

stopPreviousDevInstances();
// After kill, always drop locks for our userData dirs (dev restarts).
for (const dir of [
  join(homedir(), "Library/Application Support/Kin"),
  join(homedir(), "Library/Application Support/Kin-dev"),
]) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* ignore */
    }
  }
}
clearStaleSingletonLocks();

const env = { ...process.env };
// Critical: must not run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
// Avoid inheriting "already packaged" lies from host IDEs.
delete env.ELECTRON_FORCE_IS_PACKAGED;
// Mark explicit dev launch (sidecar path, assets) even if isPackaged mis-detects.
env.KIN_DESKTOP_DEV = "1";

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
