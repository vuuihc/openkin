const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// ADR 0036 §2: the shared TypeScript under ui/ is imported in place. Metro
// watches the repository root, and expo/metro-config reads the @ui/* alias from
// tsconfig.json, so nothing is copied out of ui/.
config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

// ADR 0036 §2: a shared module that carries a browser global resolves to its
// named RN adapter. The seam is the resolved file path, not an import
// specifier the caller controls, because shared modules import each other by
// relative path (`phoneSessionBuckets` imports `./taskOrder`).
const sharedAdapters = new Map([
  // Adapter 1: the shared transcript projection imports the web i18n module
  // for its labels, and that module reads `localStorage`/`window`.
  [
    path.resolve(repoRoot, "ui/src/i18n/index.ts"),
    path.resolve(projectRoot, "src/i18n.ts"),
  ],
  // Adapter 3: R3's grouping import reaches `ui/src/lib/taskOrder.ts`, whose
  // storage helpers read `localStorage`.
  [
    path.resolve(repoRoot, "ui/src/lib/taskOrder.ts"),
    path.resolve(projectRoot, "src/list/taskOrder.ts"),
  ],
]);
const previousResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = previousResolveRequest ?? context.resolveRequest;
  const resolved = resolve(context, moduleName, platform);
  if (resolved && resolved.type === "sourceFile") {
    const adapter = sharedAdapters.get(resolved.filePath);
    if (adapter !== undefined) return { ...resolved, filePath: adapter };
  }
  return resolved;
};

module.exports = config;
