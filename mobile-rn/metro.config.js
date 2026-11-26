const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// expo-router builds its route table from `require.context("./app")`, whose
// pattern matches every `.ts`/`.tsx` file in the route directory — including
// `app/list.focus.test.tsx`. Bundling that test pulls
// `@testing-library/react-native` into the app graph, and its `require
// ("console")` is not resolvable on Hermes: the whole app dies on a red box
// before the first frame. Tests are not routes, so Metro's file map must not
// offer them to the context module at all. Jest is unaffected: it resolves
// through its own resolver, not this config.
//
// The default block list (Metro's own caches and duplicates) is kept; this
// adds the route directory's test files beside it.
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(defaultBlockList) ? defaultBlockList : [defaultBlockList]),
  /[\\/]app[\\/].*\.test\.[tj]sx?$/,
].filter(Boolean);

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
