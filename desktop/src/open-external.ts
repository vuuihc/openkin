/**
 * Detect installed editors / file managers and open workspace paths in them.
 * Used by the SPA "Open in…" control on the file viewer.
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { shell } from "electron";

const execFileAsync = promisify(execFile);

export type ExternalAppId =
  | "finder"
  | "explorer"
  | "files"
  | "vscode"
  | "cursor"
  | "idea"
  | "webstorm"
  | "pycharm"
  | "goland"
  | "sublime"
  | "zed"
  | "default";

export type ExternalApp = {
  id: ExternalAppId;
  /** Stable i18n key suffix, e.g. "vscode" → workspace.openWith.vscode */
  labelKey: string;
  /** Fallback English label when i18n is unavailable. */
  label: string;
  /** Open the parent folder in the file manager instead of the file. */
  reveal?: boolean;
};

type AppProbe = ExternalApp & {
  /** Return true when the app appears installed on this machine. */
  detect: () => Promise<boolean> | boolean;
  /** Open `targetPath` (absolute) with this app. */
  open: (targetPath: string) => Promise<void>;
};

const MAC_APPS: Array<{
  id: ExternalAppId;
  labelKey: string;
  label: string;
  bundle: string;
  /** CLI inside the .app bundle (relative to Contents/MacOS/). */
  binary?: string;
}> = [
  {
    id: "vscode",
    labelKey: "vscode",
    label: "VS Code",
    bundle: "Visual Studio Code.app",
    binary: "Electron",
  },
  {
    id: "cursor",
    labelKey: "cursor",
    label: "Cursor",
    bundle: "Cursor.app",
  },
  {
    id: "idea",
    labelKey: "idea",
    label: "IntelliJ IDEA",
    bundle: "IntelliJ IDEA.app",
  },
  {
    id: "idea",
    labelKey: "idea",
    label: "IntelliJ IDEA CE",
    bundle: "IntelliJ IDEA CE.app",
  },
  {
    id: "webstorm",
    labelKey: "webstorm",
    label: "WebStorm",
    bundle: "WebStorm.app",
  },
  {
    id: "pycharm",
    labelKey: "pycharm",
    label: "PyCharm",
    bundle: "PyCharm.app",
  },
  {
    id: "goland",
    labelKey: "goland",
    label: "GoLand",
    bundle: "GoLand.app",
  },
  {
    id: "sublime",
    labelKey: "sublime",
    label: "Sublime Text",
    bundle: "Sublime Text.app",
  },
  {
    id: "zed",
    labelKey: "zed",
    label: "Zed",
    bundle: "Zed.app",
  },
];

const WIN_CMDS: Array<{
  id: ExternalAppId;
  labelKey: string;
  label: string;
  /** Candidate absolute paths or PATH commands. */
  candidates: string[];
}> = [
  {
    id: "vscode",
    labelKey: "vscode",
    label: "VS Code",
    candidates: [
      process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe`
        : "",
      process.env.PROGRAMFILES
        ? `${process.env.PROGRAMFILES}\\Microsoft VS Code\\Code.exe`
        : "",
      "code.cmd",
      "code",
    ],
  },
  {
    id: "cursor",
    labelKey: "cursor",
    label: "Cursor",
    candidates: [
      process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\Programs\\cursor\\Cursor.exe`
        : "",
      "cursor.cmd",
      "cursor",
    ],
  },
  {
    id: "idea",
    labelKey: "idea",
    label: "IntelliJ IDEA",
    candidates: ["idea64.exe", "idea.bat", "idea"],
  },
  {
    id: "sublime",
    labelKey: "sublime",
    label: "Sublime Text",
    candidates: [
      process.env.PROGRAMFILES
        ? `${process.env.PROGRAMFILES}\\Sublime Text\\sublime_text.exe`
        : "",
      "subl",
    ],
  },
  {
    id: "zed",
    labelKey: "zed",
    label: "Zed",
    candidates: ["zed.exe", "zed"],
  },
];

const LINUX_CMDS: Array<{
  id: ExternalAppId;
  labelKey: string;
  label: string;
  commands: string[];
}> = [
  { id: "vscode", labelKey: "vscode", label: "VS Code", commands: ["code", "code-insiders"] },
  { id: "cursor", labelKey: "cursor", label: "Cursor", commands: ["cursor"] },
  { id: "idea", labelKey: "idea", label: "IntelliJ IDEA", commands: ["idea", "intellij-idea-ultimate", "intellij-idea-community"] },
  { id: "webstorm", labelKey: "webstorm", label: "WebStorm", commands: ["webstorm"] },
  { id: "pycharm", labelKey: "pycharm", label: "PyCharm", commands: ["pycharm", "pycharm-professional", "pycharm-community"] },
  { id: "goland", labelKey: "goland", label: "GoLand", commands: ["goland"] },
  { id: "sublime", labelKey: "sublime", label: "Sublime Text", commands: ["subl", "sublime_text"] },
  { id: "zed", labelKey: "zed", label: "Zed", commands: ["zed", "zeditor"] },
];

function macAppPath(bundle: string): string | null {
  const candidates = [
    `/Applications/${bundle}`,
    `${process.env.HOME || ""}/Applications/${bundle}`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

async function commandExists(cmd: string): Promise<boolean> {
  if (!cmd) return false;
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd);
  }
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [cmd], { timeout: 2000, windowsHide: true });
    } else {
      await execFileAsync("which", [cmd], { timeout: 2000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[]): Promise<void> {
  await execFileAsync(cmd, args, {
    timeout: 15_000,
    windowsHide: true,
  });
}

function buildProbes(): AppProbe[] {
  const platform = process.platform;
  const probes: AppProbe[] = [];

  // File manager first — always available on desktop.
  if (platform === "darwin") {
    probes.push({
      id: "finder",
      labelKey: "finder",
      label: "Finder",
      reveal: true,
      detect: () => true,
      open: async (targetPath) => {
        // Reveal selects the file in Finder; fall back to open parent.
        try {
          shell.showItemInFolder(targetPath);
        } catch {
          await shell.openPath(dirname(targetPath));
        }
      },
    });
  } else if (platform === "win32") {
    probes.push({
      id: "explorer",
      labelKey: "explorer",
      label: "File Explorer",
      reveal: true,
      detect: () => true,
      open: async (targetPath) => {
        try {
          shell.showItemInFolder(targetPath);
        } catch {
          await shell.openPath(dirname(targetPath));
        }
      },
    });
  } else {
    probes.push({
      id: "files",
      labelKey: "files",
      label: "Files",
      reveal: true,
      detect: () => true,
      open: async (targetPath) => {
        try {
          shell.showItemInFolder(targetPath);
        } catch {
          await shell.openPath(dirname(targetPath));
        }
      },
    });
  }

  if (platform === "darwin") {
    const seen = new Set<ExternalAppId>();
    for (const app of MAC_APPS) {
      if (seen.has(app.id)) {
        // Prefer first matching bundle (e.g. IDEA Ultimate before CE).
        continue;
      }
      const bundlePath = macAppPath(app.bundle);
      if (!bundlePath) continue;
      seen.add(app.id);
      probes.push({
        id: app.id,
        labelKey: app.labelKey,
        label: app.label,
        detect: () => true,
        open: async (targetPath) => {
          // `open -a` launches / focuses the app with the file.
          await run("open", ["-a", bundlePath, targetPath]);
        },
      });
    }
    // Also pick up CLI shims if the .app was not in standard locations.
    const cliExtras: Array<{ id: ExternalAppId; labelKey: string; label: string; cmd: string }> = [
      { id: "vscode", labelKey: "vscode", label: "VS Code", cmd: "code" },
      { id: "cursor", labelKey: "cursor", label: "Cursor", cmd: "cursor" },
      { id: "zed", labelKey: "zed", label: "Zed", cmd: "zed" },
      { id: "sublime", labelKey: "sublime", label: "Sublime Text", cmd: "subl" },
    ];
    for (const extra of cliExtras) {
      if (seen.has(extra.id)) continue;
      probes.push({
        id: extra.id,
        labelKey: extra.labelKey,
        label: extra.label,
        detect: () => commandExists(extra.cmd),
        open: async (targetPath) => {
          await run(extra.cmd, [targetPath]);
        },
      });
    }
  } else if (platform === "win32") {
    for (const app of WIN_CMDS) {
      probes.push({
        id: app.id,
        labelKey: app.labelKey,
        label: app.label,
        detect: async () => {
          for (const c of app.candidates) {
            if (await commandExists(c)) return true;
          }
          return false;
        },
        open: async (targetPath) => {
          for (const c of app.candidates) {
            if (await commandExists(c)) {
              await run(c, [targetPath]);
              return;
            }
          }
          throw new Error(`${app.label} is not available`);
        },
      });
    }
  } else {
    for (const app of LINUX_CMDS) {
      probes.push({
        id: app.id,
        labelKey: app.labelKey,
        label: app.label,
        detect: async () => {
          for (const c of app.commands) {
            if (await commandExists(c)) return true;
          }
          return false;
        },
        open: async (targetPath) => {
          for (const c of app.commands) {
            if (await commandExists(c)) {
              await run(c, [targetPath]);
              return;
            }
          }
          throw new Error(`${app.label} is not available`);
        },
      });
    }
  }

  // Always offer the OS default handler last.
  probes.push({
    id: "default",
    labelKey: "default",
    label: "Default app",
    detect: () => true,
    open: async (targetPath) => {
      const err = await shell.openPath(targetPath);
      if (err) throw new Error(err);
    },
  });

  return probes;
}

let cachedApps: ExternalApp[] | null = null;
let cacheAt = 0;
const CACHE_MS = 60_000;

export async function listExternalApps(): Promise<ExternalApp[]> {
  const now = Date.now();
  if (cachedApps && now - cacheAt < CACHE_MS) {
    return cachedApps;
  }
  const probes = buildProbes();
  const available: ExternalApp[] = [];
  const seen = new Set<ExternalAppId>();
  for (const p of probes) {
    if (seen.has(p.id)) continue;
    try {
      if (await p.detect()) {
        seen.add(p.id);
        available.push({
          id: p.id,
          labelKey: p.labelKey,
          label: p.label,
          reveal: p.reveal,
        });
      }
    } catch {
      // ignore probe failures
    }
  }
  cachedApps = available;
  cacheAt = now;
  return available;
}

export async function openPathInApp(
  targetPath: string,
  appId: ExternalAppId,
): Promise<void> {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("path is required");
  }
  // Only allow absolute filesystem paths (no URLs / schemes).
  const ok =
    targetPath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(targetPath) ||
    targetPath.startsWith("\\\\");
  if (!ok) {
    throw new Error("path must be absolute");
  }
  if (!existsSync(targetPath)) {
    throw new Error(`path does not exist: ${targetPath}`);
  }

  const probes = buildProbes();
  const probe = probes.find((p) => p.id === appId);
  if (!probe) {
    throw new Error(`unknown app: ${appId}`);
  }
  if (!(await probe.detect())) {
    throw new Error(`${probe.label} is not installed`);
  }
  await probe.open(targetPath);
}
