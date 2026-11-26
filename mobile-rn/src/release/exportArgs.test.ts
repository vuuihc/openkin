import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";

/**
 * KIN-MOBILE-001 — the TestFlight upload path.
 *
 * `mobile/scripts/release-ios.sh` is the only supported way the phone build
 * reaches TestFlight. Uploading is the one step that needs an Apple account:
 * by default it borrows the Apple ID the Mac is signed in to in Xcode, and on
 * a Mac that is not signed in the export fails with "App Store Connect access
 * for team … is required". The shared runner adds App Store Connect API-key
 * auth when KIN_ASC_* is set, so a build can be cut unattended.
 *
 * This suite drives the real bash library with `xcodebuild` replaced by a
 * shell function, in temp dirs: no Xcode, simulator, network, or Apple
 * account is involved, and no key material exists on disk beyond a sentinel
 * file whose contents must never be printed.
 */

const REPO = path.resolve(__dirname, "../../..");
const LIB = path.join(REPO, "mobile/scripts/lib/export-args.sh");
const RELEASE_SCRIPT = path.join(REPO, "mobile/scripts/release-ios.sh");

const KEY_ID = "ABC123DEFG";
const ISSUER_ID = "00000000-0000-0000-0000-000000000000";
const KEY_BODY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n";

const BASE_ARGS = [
  "-archivePath",
  "/tmp/Kin.xcarchive",
  "-exportPath",
  "/tmp/export",
  "-exportOptionsPlist",
  "/tmp/ExportOptions.plist",
  "-allowProvisioningUpdates",
];
/** The argv this script has always produced, with no API key in play. */
const BASE_ARGV = ["-exportArchive", ...BASE_ARGS];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kin-export-"));
  tempDirs.push(dir);
  return dir;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A placeholder AuthKey file; its contents stand in for the real private key. */
function writeKeyFile(): string {
  const keyPath = path.join(tempDir(), `AuthKey_${KEY_ID}.p8`);
  fs.writeFileSync(keyPath, KEY_BODY, { mode: 0o600 });
  return keyPath;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.KIN_ASC_KEY_PATH;
  delete env.KIN_ASC_KEY_ID;
  delete env.KIN_ASC_ISSUER_ID;
  return env;
}

interface ExportRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The argv handed to `xcodebuild`, or [] when it was never called. */
  argv: string[];
  xcodebuildCalled: boolean;
}

/**
 * Run the real `run_ios_export` from the library with `xcodebuild` shadowed by
 * a function that records its argv. The driver keeps the script's own
 * `set -euo pipefail`, so a refused export exits non-zero with no argv.
 */
function runExport(env: Record<string, string> = {}): ExportRun {
  const dir = tempDir();
  const argvOut = path.join(dir, "argv.txt");
  const driver = path.join(dir, "driver.sh");
  fs.writeFileSync(
    driver,
    [
      "set -euo pipefail",
      `source ${shellQuote(LIB)}`,
      'xcodebuild() { printf "%s\\n" "$@" > "$KIN_TEST_ARGV_OUT"; }',
      `run_ios_export ${BASE_ARGS.map(shellQuote).join(" ")}`,
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", [driver], {
    env: { ...cleanEnv(), KIN_TEST_ARGV_OUT: argvOut, ...env },
    encoding: "utf8",
  });

  const xcodebuildCalled = fs.existsSync(argvOut);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    // Keep empty elements: an argument that regressed to "" must not vanish.
    argv: xcodebuildCalled
      ? fs.readFileSync(argvOut, "utf8").replace(/\n$/, "").split("\n")
      : [],
    xcodebuildCalled,
  };
}

describe("KIN-MOBILE-001 release: TestFlight export auth", () => {
  it("KIN-MOBILE-001 release: no ASC key env keeps the export argv unchanged", () => {
    const run = runExport();

    expect(run.status).toBe(0);
    expect(run.argv).toEqual(BASE_ARGV);
    expect(run.argv.join(" ")).not.toContain("authenticationKey");
    // The upload line must say which auth path it took.
    expect(run.stdout).toContain("Xcode account");
  });

  it("KIN-MOBILE-001 release: a complete ASC key trio adds the three flags verbatim", () => {
    const keyPath = writeKeyFile();
    const run = runExport({
      KIN_ASC_KEY_PATH: keyPath,
      KIN_ASC_KEY_ID: KEY_ID,
      KIN_ASC_ISSUER_ID: ISSUER_ID,
    });

    expect(run.status).toBe(0);
    expect(run.argv.slice(0, BASE_ARGV.length)).toEqual(BASE_ARGV);
    const authStart = run.argv.indexOf("-authenticationKeyPath");
    expect(authStart).toBeGreaterThanOrEqual(0);
    expect(run.argv.slice(authStart)).toEqual([
      "-authenticationKeyPath",
      keyPath,
      "-authenticationKeyID",
      KEY_ID,
      "-authenticationKeyIssuerID",
      ISSUER_ID,
    ]);

    // The visible line names the mode and the path, never the key contents.
    expect(run.stdout).toContain("API key");
    expect(run.stdout).toContain(keyPath);
    expect(run.stdout).not.toContain("BEGIN PRIVATE KEY");
    expect(run.stdout).not.toContain("not-a-real-key");
  });

  it("KIN-MOBILE-001 release: a partial ASC key trio is refused before xcodebuild", () => {
    const keyPath = writeKeyFile();
    const cases: Array<{ label: string; env: Record<string, string>; missing: string[] }> = [
      {
        label: "path only",
        env: { KIN_ASC_KEY_PATH: keyPath },
        missing: ["KIN_ASC_KEY_ID", "KIN_ASC_ISSUER_ID"],
      },
      {
        label: "key id only",
        env: { KIN_ASC_KEY_ID: KEY_ID },
        missing: ["KIN_ASC_KEY_PATH", "KIN_ASC_ISSUER_ID"],
      },
      {
        label: "issuer only",
        env: { KIN_ASC_ISSUER_ID: ISSUER_ID },
        missing: ["KIN_ASC_KEY_PATH", "KIN_ASC_KEY_ID"],
      },
      {
        label: "path and key id",
        env: { KIN_ASC_KEY_PATH: keyPath, KIN_ASC_KEY_ID: KEY_ID },
        missing: ["KIN_ASC_ISSUER_ID"],
      },
      {
        label: "key id and issuer",
        env: { KIN_ASC_KEY_ID: KEY_ID, KIN_ASC_ISSUER_ID: ISSUER_ID },
        missing: ["KIN_ASC_KEY_PATH"],
      },
    ];

    for (const testCase of cases) {
      const run = runExport(testCase.env);
      // Pack the label into the compared value so a failure names its case.
      expect({
        case: testCase.label,
        refused: run.status !== 0,
        called: run.xcodebuildCalled,
      }).toEqual({
        case: testCase.label,
        refused: true,
        called: false,
      });
      // The refusal names the variable it wants.
      expect({
        case: testCase.label,
        namesMissing: run.stderr.includes(testCase.missing[0]),
      }).toEqual({ case: testCase.label, namesMissing: true });
    }
  });

  it("KIN-MOBILE-001 release: an ASC key path that is not a file is refused before xcodebuild", () => {
    const missingPath = path.join(tempDir(), "AuthKey_MISSING.p8");
    const directoryPath = tempDir();
    const cases = [
      { label: "no such file", keyPath: missingPath },
      { label: "a directory", keyPath: directoryPath },
    ];

    for (const testCase of cases) {
      const run = runExport({
        KIN_ASC_KEY_PATH: testCase.keyPath,
        KIN_ASC_KEY_ID: KEY_ID,
        KIN_ASC_ISSUER_ID: ISSUER_ID,
      });

      expect({
        case: testCase.label,
        refused: run.status !== 0,
        called: run.xcodebuildCalled,
        // The refusal names the object: the path and the variable.
        namesPath: run.stderr.includes(testCase.keyPath),
        namesVariable: run.stderr.includes("KIN_ASC_KEY_PATH"),
      }).toEqual({
        case: testCase.label,
        refused: true,
        called: false,
        namesPath: true,
        namesVariable: true,
      });
    }
  });

  it("KIN-MOBILE-001 release: release-ios.sh uploads through the shared export runner", () => {
    const source = fs.readFileSync(RELEASE_SCRIPT, "utf8");
    // Comments may name the flags; only executable lines can carry a second argv.
    const executable = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    // The script must load the library and call its runner ...
    expect(source).toMatch(/source\s+"[^"]*lib\/export-args\.sh"/);
    expect(source).toMatch(/^run_ios_export\s+\\$/m);
    // ... so the library cannot be green while the script keeps a second argv.
    expect(executable).not.toMatch(/xcodebuild\s+-exportArchive/);
    expect(executable).not.toMatch(/-authenticationKey(Path|ID|IssuerID)/);
  });
});
