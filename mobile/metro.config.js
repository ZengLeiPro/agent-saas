const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Watch the entire monorepo root so Metro can resolve hoisted node_modules
config.watchFolders = [monorepoRoot];

// Resolve modules from project root and monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Map @agent/shared to the shared package source
config.resolver.extraNodeModules = {
  '@agent/shared': path.resolve(monorepoRoot, 'shared/src'),
};

module.exports = config;
