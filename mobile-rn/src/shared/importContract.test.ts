import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import * as ts from "typescript";

/**
 * KIN-MOBILE-001 R1 — the shared-import contract from ADR 0036 §2.
 *
 * The RN bundle imports the web console's DOM-free TypeScript in place. This
 * test walks the real import closure of the RN source (relative imports plus
 * tsconfig `paths`), then enforces three rules:
 *
 *   1. no module in the closure references a browser global;
 *   2. every shared module reached through an alias is named in ADR 0036;
 *   3. the shared modules that do carry DOM references are exactly the ones
 *      mapped to a named RN adapter (empty in R1).
 *
 * Imports of bare packages are left to Metro/node_modules. `import type` /
 * `export type` declarations are not followed: TypeScript erases them, which is
 * why ADR 0036 §2 lets a shared type import reach the RN bundle unchanged.
 */

const MOBILE_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(MOBILE_ROOT, "..");
const TSCONFIG_PATH = path.join(MOBILE_ROOT, "tsconfig.json");
const ADR_PATH = path.join(
  REPO_ROOT,
  "docs/adr/0036-rn-client-layout-shared-ts-and-light-gate.md",
);

const SOURCE_FILE = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DOM_IDENTIFIERS = new Set(["window", "document", "localStorage", "sessionStorage"]);

type ImportRef = { specifier: string; typeOnly: boolean };
type Closure = {
  files: Set<string>;
  aliased: Set<string>;
  /** Every `ui/` module reached before any adapter substitution. */
  rawShared: Set<string>;
};

function repoPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".expo") continue;
      found.push(...listSources(abs));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      found.push(abs);
    }
  }
  return found;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
}

function importsOf(file: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // `import type { A }` and `import { type A }` are both erased by the
      // TypeScript transform, so neither may pull a browser module into the
      // RN bundle. Only a clause with at least one value binding is followed.
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allNamedTypeOnly =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      refs.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: clause?.isTypeOnly === true || allNamedTypeOnly,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        const callee = node.expression;
        const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(callee) && callee.text === "require";
        if (isDynamicImport || isRequire) {
          refs.push({ specifier: argument.text, typeOnly: false });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return refs;
}

const tsconfig = JSON.parse(fs.readFileSync(TSCONFIG_PATH, "utf8")) as {
  compilerOptions?: { paths?: Record<string, string[]> };
};
const aliasPaths = tsconfig.compilerOptions?.paths ?? {};

/** The `*` pattern in the tsconfig paths map that matches this specifier. */
function aliasPatternFor(specifier: string): {
  pattern: string;
  targets: string[];
  star: string;
} | null {
  for (const [pattern, targets] of Object.entries(aliasPaths)) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      if (specifier === pattern) return { pattern, targets, star: "" };
      continue;
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    return {
      pattern,
      targets,
      star: specifier.slice(prefix.length, specifier.length - suffix.length),
    };
  }
  return null;
}

function fileAt(candidate: string): string | null {
  const probes = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}.json`,
  ];
  for (const probe of probes) {
    if (fs.existsSync(probe) && fs.statSync(probe).isFile()) return probe;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const index = path.join(candidate, `index${ext}`);
    if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;
  }
  return null;
}

function resolveAlias(specifier: string): string | null {
  const match = aliasPatternFor(specifier);
  if (!match) return null;
  for (const target of match.targets) {
    const resolved = fileAt(path.resolve(MOBILE_ROOT, target.replace("*", match.star)));
    if (resolved) return resolved;
  }
  return null;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  return fileAt(path.resolve(path.dirname(fromFile), specifier));
}

function buildClosure(): Closure {
  const files = new Set<string>();
  const aliased = new Set<string>();
  const rawShared = new Set<string>();
  const queue = [
    ...listSources(path.join(MOBILE_ROOT, "app")),
    ...listSources(path.join(MOBILE_ROOT, "src")),
  ].filter((file) => !TEST_FILE.test(file));

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);

    for (const ref of importsOf(file)) {
      if (ref.typeOnly) continue;
      let target: string | null = null;
      if (ref.specifier.startsWith(".")) {
        target = resolveRelative(file, ref.specifier);
        if (!target) {
          throw new Error(
            `KIN-MOBILE-001: ${repoPath(file)} imports ${ref.specifier}, which does not resolve`,
          );
        }
      } else if (aliasPatternFor(ref.specifier)) {
        target = resolveAlias(ref.specifier);
        if (!target) {
          throw new Error(
            `KIN-MOBILE-001: ${repoPath(file)} imports ${ref.specifier}; no tsconfig alias target`,
          );
        }
        aliased.add(target);
      } else {
        // A bare package import is resolved by Metro from node_modules, not here.
        continue;
      }
      if (target.endsWith(".json")) continue;
      const relTarget = repoPath(target);
      if (relTarget.startsWith("ui/")) rawShared.add(target);
      // ADR 0036 §2: a DOM-carrying shared module is replaced by its one named
      // RN adapter. The bundle follows the alias, so this walk must too; the
      // unaliased target stays in `rawShared` so a new DOM dependency cannot be
      // papered over by adding an alias.
      const adapterRel = SHARED_ADAPTERS[relTarget];
      if (adapterRel) {
        const adapter = path.join(REPO_ROOT, adapterRel);
        if (fs.existsSync(adapter)) {
          queue.push(adapter);
          continue;
        }
      }
      queue.push(target);
    }
  }

  return { files, aliased, rawShared };
}

const domCache = new Map<string, string[]>();

/** Browser globals used as code, not words inside strings or comments. */
function domReferences(file: string): string[] {
  const cached = domCache.get(file);
  if (cached) return cached;

  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && DOM_IDENTIFIERS.has(node.text)) hits.add(node.text);
    if (
      ts.isStringLiteral(node) &&
      (node.text === "react-dom" || node.text.startsWith("react-dom/"))
    ) {
      hits.add("react-dom");
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));

  const result = [...hits];
  domCache.set(file, result);
  return result;
}

/** The shared modules ADR 0036 §2 names as importable in place. */
function isAdrNamedSharedModule(rel: string): boolean {
  return (
    rel === "ui/src/api/contract.ts" ||
    rel === "ui/src/api/generated/openapi.ts" ||
    rel === "ui/src/i18n/locales/en.ts" ||
    rel === "ui/src/i18n/locales/zh.ts" ||
    rel === "ui/src/components/chat/transcriptProjection.ts" ||
    rel.startsWith("ui/src/lib/")
  );
}

/** Literal paths the ADR must keep naming, so this list cannot drift from it. */
const ADR_NAMED_PATHS = [
  "ui/src/api/contract.ts",
  "ui/src/api/generated/openapi.ts",
  "ui/src/i18n/locales/en.ts",
  "ui/src/i18n/locales/zh.ts",
  "ui/src/components/chat/transcriptProjection.ts",
  "ui/src/lib/",
];

/**
 * ADR 0036 §2 adapters: shared module -> the one RN adapter that replaces it.
 * R3's grouping import reaches `ui/src/lib/taskOrder.ts`, whose storage helpers
 * read `localStorage`; its pure ordering function is carried by an RN adapter.
 * A module that starts carrying a DOM reference must be added here (and to the
 * ADR) or the fourth test below turns red.
 */
const SHARED_ADAPTERS: Record<string, string> = {
  "ui/src/lib/taskOrder.ts": "mobile-rn/src/list/taskOrder.ts",
};

const closure = buildClosure();
const closureByRepoPath = new Map(
  [...closure.files].map((file) => [repoPath(file), file] as const),
);

describe("KIN-MOBILE-001 R1 shared-import contract", () => {
  it("KIN-MOBILE-001: walks a closure that reaches a real shared module", () => {
    expect(closure.files.size).toBeGreaterThan(0);
    expect(closureByRepoPath.has("ui/src/i18n/locales/en.ts")).toBe(true);
  });

  it("KIN-MOBILE-001: no module in the RN closure references a browser global", () => {
    const violations = [...closure.files].flatMap((file) =>
      domReferences(file).map((ref) => `${repoPath(file)} -> ${ref}`),
    );
    expect(violations).toEqual([]);
  });

  it("KIN-MOBILE-001: every aliased shared module is named in ADR 0036", () => {
    const adr = fs.readFileSync(ADR_PATH, "utf8");
    for (const named of ADR_NAMED_PATHS) {
      expect(adr).toContain(named);
    }

    const unnamed = [...closure.aliased]
      .map(repoPath)
      .filter((rel) => rel.startsWith("ui/") && !isAdrNamedSharedModule(rel));
    expect(unnamed).toEqual([]);
  });

  it("KIN-MOBILE-001: adapter aliases equal the DOM-carrying shared modules", () => {
    const adr = fs.readFileSync(ADR_PATH, "utf8");
    // The unaliased graph: every shared module the RN source reaches, whether
    // or not an adapter later stands in for it.
    const domShared = [...closure.rawShared]
      .filter((file) => domReferences(file).length > 0)
      .map(repoPath)
      .sort();
    const adapters = Object.keys(SHARED_ADAPTERS).sort();

    expect(adapters).toEqual(domShared);

    for (const [shared, adapter] of Object.entries(SHARED_ADAPTERS)) {
      expect(fs.existsSync(path.join(REPO_ROOT, adapter))).toBe(true);
      expect(adr).toContain(shared);
      expect(adr).toContain(adapter);
    }
  });
});
