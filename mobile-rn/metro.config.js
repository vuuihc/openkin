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

// ADR 0036 §2 adapter 1: the shared transcript projection imports the web
// i18n module for its labels, and that module reads `localStorage`/`window`.
// The RN bundle gets the DOM-free adapter instead of the browser module.
const i18nIndex = path.resolve(repoRoot, "ui/src/i18n/index.ts");
const i18nAdapter = path.resolve(projectRoot, "src/i18n.ts");
const previousResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = previousResolveRequest ?? context.resolveRequest;
  const resolved = resolve(context, moduleName, platform);
  if (resolved && resolved.type === "sourceFile" && resolved.filePath === i18nIndex) {
    return { ...resolved, filePath: i18nAdapter };
  }
  return resolved;
};

module.exports = config;
