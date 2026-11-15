/**
 * Dev branding for macOS.
 *
 * Unpacked `electron .` runs node_modules/.../Electron.app — Dock, menu bar,
 * and Force Quit always show that .app's name/icon (app.setName is not enough).
 *
 * We clone Electron.app → desktop/.dev-app/Kin.app (APFS clonefile when
 * available), rename the executable to Kin, rewrite Info.plist, install icon.
 * Launch path is returned for run-electron.mjs.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const APP_NAME = "Kin";
const BUNDLE_ID = "dev.kin.app";

/**
 * @param {string} electronBin path to .../Electron.app/Contents/MacOS/Electron
 * @param {string} projectRoot desktop/
 * @returns {string} path to binary to spawn
 */
export function brandElectronApp(electronBin, projectRoot) {
  if (process.platform !== "darwin") return electronBin;

  const srcApp = join(dirname(electronBin), "..", ".."); // Electron.app
  if (!srcApp.endsWith(".app") || !existsSync(srcApp)) {
    console.warn("[kin-desktop] brand: unexpected electron path", electronBin);
    return electronBin;
  }

  const versionFile = join(dirname(srcApp), "version");
  const electronVersion = existsSync(versionFile)
    ? readFileSync(versionFile, "utf8").trim()
    : "unknown";

  // Keep clone under node_modules/electron/dist so Electron still treats this as
  // a defaultApp / unpackaged host (path contains node_modules/electron).
  // Cloning to desktop/.dev-app made app.isPackaged === true and broke sidecar paths.
  const distDir = dirname(srcApp); // .../electron/dist
  const dstApp = join(distDir, `${APP_NAME}.app`);
  const stampPath = join(distDir, `.kin-brand-stamp`);
  const expectedStamp = `${electronVersion}|${APP_NAME}|${BUNDLE_ID}`;

  const needClone =
    !existsSync(join(dstApp, "Contents", "MacOS", APP_NAME)) ||
    !existsSync(stampPath) ||
    readFileSync(stampPath, "utf8").trim() !== expectedStamp;

  if (needClone) {
    if (existsSync(dstApp)) {
      rmSync(dstApp, { recursive: true, force: true });
    }
    // APFS clonefile (-c) is near-instant; fall back to full copy.
    try {
      execFileSync("cp", ["-cR", srcApp, dstApp], { stdio: "ignore" });
    } catch {
      execFileSync("cp", ["-R", srcApp, dstApp], { stdio: "ignore" });
    }

    const macOSDir = join(dstApp, "Contents", "MacOS");
    const srcExe = join(macOSDir, "Electron");
    const dstExe = join(macOSDir, APP_NAME);
    if (existsSync(srcExe) && !existsSync(dstExe)) {
      renameSync(srcExe, dstExe);
    }

    writeFileSync(stampPath, expectedStamp, "utf8");
    console.log(`[kin-desktop] cloned dev app → ${dstApp}`);
  }

  const plist = join(dstApp, "Contents", "Info.plist");
  const resources = join(dstApp, "Contents", "Resources");
  patchPlist(plist);
  installIcon(projectRoot, resources);

  // Best-effort LaunchServices refresh so Dock picks up name/icon immediately.
  try {
    const lsregister =
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    if (existsSync(lsregister)) {
      execFileSync(lsregister, ["-f", dstApp], { stdio: "ignore" });
    }
  } catch {
    /* ignore */
  }

  const brandedBin = join(dstApp, "Contents", "MacOS", APP_NAME);
  if (!existsSync(brandedBin)) {
    console.warn("[kin-desktop] brand: binary missing, fall back to stock electron");
    return electronBin;
  }

  console.log(`[kin-desktop] using branded app ${dstApp}`);
  return brandedBin;
}

function patchPlist(plist) {
  if (!existsSync(plist)) return;

  const pb = (args) => {
    try {
      return execFileSync("/usr/libexec/PlistBuddy", args, {
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  };

  const setOrAdd = (key, type, value) => {
    const cur = pb(["-c", `Print :${key}`, plist]);
    if (cur === value) return;
    if (cur !== "") {
      pb(["-c", `Set :${key} ${value}`, plist]);
    } else {
      pb(["-c", `Add :${key} ${type} ${value}`, plist]);
    }
  };

  setOrAdd("CFBundleName", "string", APP_NAME);
  setOrAdd("CFBundleDisplayName", "string", APP_NAME);
  setOrAdd("CFBundleIdentifier", "string", BUNDLE_ID);
  setOrAdd("CFBundleExecutable", "string", APP_NAME);
  setOrAdd("CFBundleIconFile", "string", "electron.icns");
}

function installIcon(projectRoot, resources) {
  const icnsSrc = join(projectRoot, "assets", "icon.icns");
  const icnsDst = join(resources, "electron.icns");
  if (existsSync(icnsSrc)) {
    copyFileSync(icnsSrc, icnsDst);
  }
}
