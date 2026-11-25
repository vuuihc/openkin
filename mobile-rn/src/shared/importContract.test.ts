import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import * as ts from "typescript";
import metroConfig from "../../metro.config.js";

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

/** The slice of Metro's resolver result this contract asserts on. */
type MetroResolution = { type: string; filePath: string };
/** The slice of Metro's resolution context `metro.config.js` reads. */
type MetroResolutionContext = {
  resolveRequest: (
    context: MetroResolutionContext,
    moduleName: string,
    platform: string,
  ) => MetroResolution;
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

/** The names a binding pattern declares: `x`, `{ a, b: c }`, `[d]`. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...boundNames(element.name));
  }
  return names;
}

/** The names a function-like node binds for its body (its parameters, name, type parameters). */
function functionScope(node: ts.SignatureDeclarationBase): Set<string> {
  const names = new Set<string>();
  // Only a function declaration or expression binds its own name inside the
  // body; a method or accessor name is a property key, so `{ window() { return
  // window; } }` still reads the global.
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name !== undefined
  ) {
    names.add(node.name.text);
  }
  for (const typeParameter of node.typeParameters ?? []) names.add(typeParameter.name.text);
  for (const parameter of node.parameters) {
    for (const name of boundNames(parameter.name)) names.add(name);
  }
  return names;
}

/** The names a block declares for itself (hoisted enough for a lexical guard). */
function blockScope(node: ts.SourceFile | ts.Block | ts.ModuleBlock): Set<string> {
  const names = new Set<string>();
  for (const statement of node.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of boundNames(declaration.name)) names.add(name);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/**
 * True when the identifier names something rather than reading a global: a
 * declaration (`function f(window: number)`), a property key or member label
 * (`{ window: 3 }`, `type C = { window: number }`, `obj.window`, `enum E`),
 * an import binding or a type parameter. `const x = window` and
 * `window.localStorage` are reads, so they are not labels.
 */
function isDeclaredOrLabel(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;

  if (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node)
  ) {
    return true;
  }

  if (
    (ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return ts.isBindingElement(parent) && parent.propertyName === node;
}

/**
 * Browser globals the source actually reads — not words inside strings or
 * comments, not names it declares for itself.
 *
 * A name is a browser global only when it is used as a value. A declaration, a
 * parameter, a property key or a label that happens to be called `window` is
 * not one, and neither is a reference bound by such a local declaration: a
 * function that takes `window: number` reads its own parameter, not the
 * browser's. `const x = window`, `window.localStorage`, `document.title = …`
 * and a bare `localStorage` value all stay hits.
 */
export function domReferencesIn(source: string, file: string): string[] {
  const hits = new Set<string>();
  const visit = (node: ts.Node, scopes: readonly Set<string>[]): void => {
    if (ts.isIdentifier(node) && DOM_IDENTIFIERS.has(node.text)) {
      const locallyBound = scopes.some((scope) => scope.has(node.text));
      if (!locallyBound && !isDeclaredOrLabel(node)) hits.add(node.text);
    }
    if (
      ts.isStringLiteral(node) &&
      (node.text === "react-dom" || node.text.startsWith("react-dom/"))
    ) {
      hits.add("react-dom");
    }
    let inner = scopes;
    if (ts.isFunctionLike(node)) {
      inner = [...scopes, functionScope(node)];
    } else if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      inner = [...scopes, blockScope(node)];
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(
    ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file)),
    [],
  );
  return [...hits];
}

function domReferences(file: string): string[] {
  const cached = domCache.get(file);
  if (cached) return cached;

  const result = domReferencesIn(fs.readFileSync(file, "utf8"), file);
  domCache.set(file, result);
  return result;
}

/**
 * Every module specifier the compiler would follow, `import type` included.
 *
 * `tsc` resolves type-only imports even though the transform erases them, so a
 * shared module that stays importable under ADR 0036 §4's light gate (mobile-rn
 * deps only) may name no module at all — the import is the seam, not the runtime
 * load.
 */
export function moduleSpecifiersIn(source: string, file: string): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file)),
  );
  return specifiers;
}

/** The shared modules ADR 0036 §2 names as importable in place. */
function isAdrNamedSharedModule(rel: string): boolean {
  return (
    rel === "ui/src/api/contract.ts" ||
    rel === "ui/src/api/generated/openapi.ts" ||
    rel === "ui/src/i18n/locales/en.ts" ||
    rel === "ui/src/i18n/locales/zh.ts" ||
    rel === "ui/src/i18n/index.ts" ||
    rel === "ui/src/components/chat/transcriptProjection.ts" ||
    rel === "ui/src/components/chat/eventMeta.ts" ||
    rel.startsWith("ui/src/lib/")
  );
}

/** Literal paths the ADR must keep naming, so this list cannot drift from it. */
const ADR_NAMED_PATHS = [
  "ui/src/api/contract.ts",
  "ui/src/api/generated/openapi.ts",
  "ui/src/i18n/locales/en.ts",
  "ui/src/i18n/locales/zh.ts",
  "ui/src/i18n/index.ts",
  "ui/src/components/chat/transcriptProjection.ts",
  "ui/src/components/chat/eventMeta.ts",
  "ui/src/lib/",
];

/**
 * ADR 0036 §2 adapters: shared module -> the one RN adapter that replaces it.
 * The transcript projection reaches `ui/src/i18n/index.ts` for its labels, and
 * that module reads `localStorage`/`window`; R4 adds the i18n adapter that R2b
 * defined. R3's grouping import reaches `ui/src/lib/taskOrder.ts`, whose
 * storage helpers read `localStorage`; its pure ordering function is carried by
 * an RN adapter. A module that starts carrying a DOM reference must be added
 * here (and to the ADR) or the fourth test below turns red.
 */
const SHARED_ADAPTERS: Record<string, string> = {
  "ui/src/i18n/index.ts": "mobile-rn/src/i18n.ts",
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

  it("KIN-MOBILE-001: a name that declares or labels is not a browser global", () => {
    // A parameter named `window` is the local binding, not the global — also
    // where the function body reads it as a value.
    expect(
      domReferencesIn("function f(window: number) { return window + 1; }", "declared.ts"),
    ).toEqual([]);
    // An object key and a type property are labels.
    expect(
      domReferencesIn("const s = { window: 3 }; type C = { window: number };", "labels.ts"),
    ).toEqual([]);
    // A method or accessor name is a label too, but the body still reads the
    // global: only function declarations and expressions bind their own name.
    expect(
      domReferencesIn("const o = { window() { return window; } };", "method.ts"),
    ).toEqual(["window"]);

    // Real value uses stay hits; `localStorage` here is a property name of
    // `window`, while `window` itself is the expression.
    const used = domReferencesIn(
      'const el = window; window.localStorage.getItem("a"); document.title = "x";',
      "globals.ts",
    );
    expect([...used].sort()).toEqual(["document", "window"]);
  });

  it("KIN-MOBILE-001: the shared usage formatter imports nothing, so the RN typecheck stays light", () => {
    // `tsc` follows `import type` even though the transform erases it, so one
    // type import is enough to drag the web client into the RN typecheck. This
    // module is imported in place (ADR 0036 §2), so it may name no module.
    const file = path.join(REPO_ROOT, "ui/src/lib/usage.ts");
    const source = fs.readFileSync(file, "utf8");
    expect(moduleSpecifiersIn(source, file)).toEqual([]);
    expect(domReferences(file)).toEqual([]);
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

    // Every DOM-carrying shared module the walk reached must be redirected to
    // an adapter; nothing else may be.
    expect(adapters).toEqual(domShared);

    for (const [shared, adapter] of Object.entries(SHARED_ADAPTERS)) {
      expect(fs.existsSync(path.join(REPO_ROOT, adapter))).toBe(true);
      expect(adr).toContain(shared);
      expect(adr).toContain(adapter);
    }
  });

  it("KIN-MOBILE-001: metro's resolver carries every adapter alias", () => {
    // The closure walk above reads the source tree; this reads the shipped
    // resolver. The walk applies SHARED_ADAPTERS itself, so deleting the
    // substitution from metro.config.js would leave it green while the real
    // bundle resolved the shared module with its DOM helpers.
    expect(typeof metroConfig.resolver.resolveRequest).toBe("function");
    const resolveRequest = metroConfig.resolver.resolveRequest as unknown as (
      context: MetroResolutionContext,
      moduleName: string,
      platform: string,
    ) => MetroResolution | null;

    for (const [shared, adapter] of Object.entries(SHARED_ADAPTERS)) {
      const upstream: MetroResolution = {
        type: "sourceFile",
        filePath: path.join(REPO_ROOT, shared),
      };
      const context: MetroResolutionContext = {
        resolveRequest: () => upstream,
      };
      expect(resolveRequest(context, shared, "ios")).toEqual({
        type: "sourceFile",
        filePath: path.join(REPO_ROOT, adapter),
      });
    }

    // A shared module that is not an adapter seam is passed through unchanged.
    const untouched: MetroResolution = {
      type: "sourceFile",
      filePath: path.join(REPO_ROOT, "ui/src/lib/phoneSessionBuckets.ts"),
    };
    const context: MetroResolutionContext = {
      resolveRequest: () => untouched,
    };
    expect(resolveRequest(context, "phoneSessionBuckets", "ios")).toEqual(
      untouched,
    );
  });

  it("KIN-MOBILE-001: metro never offers a test file to the route context", () => {
    // expo-router builds its route table from require.context("./app"), whose
    // pattern matches every .ts/.tsx file in the directory — test files
    // included. Bundling one pulls @testing-library/react-native into the app
    // graph, whose require("console") Hermes cannot resolve; on the simulator
    // that is a red box before the first frame (2026-11-25). Metro's block
    // list is the only seam that keeps them out of the file map, so a test
    // file appearing under app/ must match it.
    const blockList = metroConfig.resolver.blockList;
    const patterns = (Array.isArray(blockList) ? blockList : [blockList]).filter(
      (entry): entry is RegExp => entry instanceof RegExp,
    );
    const blocked = (file: string): boolean =>
      patterns.some((pattern) => pattern.test(file));

    const routeTests = listSources(path.join(MOBILE_ROOT, "app")).filter((file) =>
      TEST_FILE.test(file),
    );
    // Today's route directory does carry one; the day it stops, this test must
    // be re-read rather than silently pass on an empty list.
    expect(routeTests.length).toBeGreaterThan(0);
    for (const file of routeTests) {
      expect({ file: repoPath(file), blocked: blocked(file) }).toEqual({
        file: repoPath(file),
        blocked: true,
      });
    }

    // A real route stays in the file map: the block is about tests, not the
    // route directory.
    expect(blocked(path.join(MOBILE_ROOT, "app/list.tsx"))).toBe(false);
    expect(blocked(path.join(MOBILE_ROOT, "app/thread/[id].tsx"))).toBe(false);
  });
});
