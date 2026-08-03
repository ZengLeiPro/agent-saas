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

// shared 包使用 NodeNext 风格的相对导入（import "./x.js" 实际指向 x.ts）。
// tsc/vite 原生支持该映射，Metro 不支持——这里补上 .js -> .ts/.tsx 的回退解析。
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest
    ? (name) => defaultResolveRequest(context, name, platform)
    : (name) => context.resolveRequest(context, name, platform);
  if (
    (moduleName.startsWith('./') || moduleName.startsWith('../')) &&
    moduleName.endsWith('.js')
  ) {
    const base = moduleName.slice(0, -3);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, moduleName]) {
      try {
        return resolve(candidate);
      } catch {
        // try next candidate
      }
    }
  }
  return resolve(moduleName);
};

module.exports = config;
