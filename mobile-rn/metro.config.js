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

module.exports = config;
