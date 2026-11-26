import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";

/**
 * R-rn-testflight — the iOS release config the archive is built from.
 *
 * `scripts/release-ios.sh` runs `expo prebuild` over `app.json` and archives the
 * result; no Xcode project is committed, so app.json is the only place the
 * TestFlight app record, the URL scheme the Hub sign-in returns on, and the
 * export-compliance answer are written down. These assertions are that
 * contract: a value drifting here produces a build nobody can install or
 * upload, and the failure should happen in `jest`, not in App Store Connect.
 */

const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const APP_JSON = path.join(PACKAGE_ROOT, "app.json");
const PNG_SIGNATURE = "89504e470d0a1a0a";

type AppConfig = {
  expo: {
    version?: string;
    scheme?: string;
    icon?: string;
    ios?: {
      buildNumber?: string;
      bundleIdentifier?: string;
      infoPlist?: Record<string, unknown>;
    };
  };
};

const config = JSON.parse(fs.readFileSync(APP_JSON, "utf8")) as AppConfig;

describe("R-rn-testflight: the iOS release config", () => {
  it("R-rn-testflight: the archive targets the TestFlight app record", () => {
    expect(config.expo.ios?.bundleIdentifier).toBe("dev.openkin.ios");
  });

  it("R-rn-testflight: the Hub sign-in callback keeps the kin scheme", () => {
    expect(config.expo.scheme).toBe("kin");
  });

  it("R-rn-testflight: the export compliance answer rides in the archive", () => {
    expect(config.expo.ios?.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it("R-rn-testflight: a LAN node stays reachable over http", () => {
    expect(config.expo.ios?.infoPlist?.NSAppTransportSecurity).toEqual({
      NSAllowsLocalNetworking: true,
    });
  });

  it("R-rn-testflight: the icon app.json names is a 1024 square PNG", () => {
    const icon = config.expo.icon;
    expect(typeof icon).toBe("string");
    if (typeof icon !== "string") throw new Error("app.json names no icon");
    const file = path.resolve(PACKAGE_ROOT, icon);
    expect(fs.existsSync(file)).toBe(true);
    const png = fs.readFileSync(file);
    expect(png.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });

  it("R-rn-testflight: the script, not app.json, owns the build number", () => {
    expect(config.expo.ios?.buildNumber).toBeUndefined();
  });

  it("R-rn-testflight: the marketing version matches the Capacitor default", () => {
    expect(config.expo.version).toBe("1.0");
  });
});
