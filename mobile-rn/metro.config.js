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
// named RN adapter. `phoneSessionBuckets` imports `./taskOrder`, so the seam is
// the resolved file path, not an import specifier the caller controls.
const taskOrderShared = path.resolve(repoRoot, "ui/src/lib/taskOrder.ts");
const taskOrderAdapter = path.resolve(projectRoot, "src/list/taskOrder.ts");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = context.resolveRequest(context, moduleName, platform);
  if (
    resolved &&
    resolved.type === "sourceFile" &&
    resolved.filePath === taskOrderShared
  ) {
    return { type: "sourceFile", filePath: taskOrderAdapter };
  }
  return resolved;
};

module.exports = config;
