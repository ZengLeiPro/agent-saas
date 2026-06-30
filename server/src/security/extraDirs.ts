import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type UserOverride = {
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  extraDirs?: string[];
  allowGhCli?: boolean;
};

export type UserOverrides = Record<string, UserOverride>;

interface SanitizeUserOverridesOptions {
  processCwd: string;
  globalAgentCwd: string;
}

interface ProtectedPath {
  path: string;
  reason: string;
}

export function isPathWithinDirectory(targetPath: string, directory: string): boolean {
  return targetPath === directory || targetPath.startsWith(directory + '/');
}

export function pathsOverlap(pathA: string, pathB: string): boolean {
  return isPathWithinDirectory(pathA, pathB) || isPathWithinDirectory(pathB, pathA);
}

export function isPathWithinAnyDirectory(targetPath: string, directories: string[]): boolean {
  return directories.some(directory => isPathWithinDirectory(targetPath, directory));
}

export function getUserExtraDirs(
  userOverrides: UserOverrides | undefined,
  username: string | undefined,
): string[] {
  if (!username) return [];
  return userOverrides?.[username]?.extraDirs ?? [];
}

export function getUserAllowGhCli(
  userOverrides: UserOverrides | undefined,
  username: string | undefined,
): boolean {
  if (!username) return false;
  return userOverrides?.[username]?.allowGhCli === true;
}

export function resolveAuthorizedPath(
  requestedPath: string,
  primaryRoot: string,
  extraDirs: string[] = [],
): string | null {
  const absolutePath = requestedPath.startsWith('/')
    ? resolve(requestedPath)
    : resolve(primaryRoot, requestedPath);
  return isPathWithinDirectory(absolutePath, primaryRoot) || isPathWithinAnyDirectory(absolutePath, extraDirs)
    ? absolutePath
    : null;
}

export function sanitizeUserOverrides(
  userOverrides: UserOverrides | undefined,
  options: SanitizeUserOverridesOptions,
): UserOverrides | undefined {
  if (!userOverrides) return undefined;

  const protectedPaths = buildProtectedPaths(options);
  const sanitizedEntries = Object.entries(userOverrides).map(([username, override]) => {
    const extraDirs = sanitizeExtraDirs(override.extraDirs, username, protectedPaths);
    return [username, extraDirs.length > 0 ? { ...override, extraDirs } : { ...override, extraDirs: undefined }];
  });

  return Object.fromEntries(sanitizedEntries);
}

function sanitizeExtraDirs(
  extraDirs: string[] | undefined,
  username: string,
  protectedPaths: ProtectedPath[],
): string[] {
  if (!extraDirs || extraDirs.length === 0) return [];

  const deduped = new Set<string>();
  for (const rawDir of extraDirs) {
    const normalized = normalizeExistingDirectory(rawDir);
    if (normalized === '/') {
      throw new Error(`agent.userOverrides.${username}.extraDirs cannot include filesystem root '/'`);
    }
    for (const protectedPath of protectedPaths) {
      if (pathsOverlap(normalized, protectedPath.path)) {
        throw new Error(
          `agent.userOverrides.${username}.extraDirs contains protected path overlap: ${normalized} overlaps ${protectedPath.path} (${protectedPath.reason})`,
        );
      }
    }
    deduped.add(normalized);
  }

  return [...deduped];
}

function normalizeExistingDirectory(rawDir: string): string {
  const normalized = resolve(rawDir);
  if (!existsSync(normalized)) return normalized;

  const stats = lstatSync(normalized);
  const resolvedPath = stats.isSymbolicLink() ? realpathSync(normalized) : normalized;
  const realStats = lstatSync(resolvedPath);
  if (!realStats.isDirectory()) {
    throw new Error(`extraDirs entry must point to a directory: ${rawDir}`);
  }
  return resolvedPath;
}

function buildProtectedPaths(options: SanitizeUserOverridesOptions): ProtectedPath[] {
  const home = homedir();
  const processCwd = resolve(options.processCwd);
  const globalAgentCwd = resolve(options.globalAgentCwd);

  return [
    { path: globalAgentCwd, reason: 'workspace root must stay isolated' },
    { path: processCwd, reason: 'agent service repository must stay isolated' },
    { path: resolve(home, '.claude'), reason: 'Claude session/config data is sensitive' },
    { path: resolve(home, '.ssh'), reason: 'SSH keys are sensitive' },
    { path: resolve(home, '.git-credentials'), reason: 'Git credentials are sensitive' },
    { path: resolve(home, '.npmrc'), reason: 'package registry credentials are sensitive' },
    { path: resolve(home, '.netrc'), reason: 'network credentials are sensitive' },
    { path: resolve(home, '.config', 'gcloud'), reason: 'cloud credentials are sensitive' },
    { path: resolve(home, '.config', 'gh'), reason: 'GitHub credentials are sensitive' },
    { path: resolve(home, '.config', 'docker'), reason: 'container credentials are sensitive' },
    { path: resolve(home, '.config', 'aws'), reason: 'cloud credentials are sensitive' },
    { path: resolve(home, '.config', 'frp'), reason: 'proxy configuration is sensitive' },
    { path: resolve(home, '.config', 'mihomo'), reason: 'proxy configuration is sensitive' },
    { path: resolve(home, '.config', 'clash'), reason: 'proxy configuration is sensitive' },
    { path: resolve(home, '.config', 'wireguard'), reason: 'network tunnel configuration is sensitive' },
    { path: resolve(home, 'Library', 'Application Support', 'Surge'), reason: 'proxy configuration is sensitive' },
    { path: resolve(home, 'Library', 'Keychains'), reason: 'system credentials are sensitive' },
    { path: resolve(home, 'Library', 'Application Support', 'Google', 'Chrome'), reason: 'browser profile data is sensitive' },
    { path: resolve(home, 'Library', 'Mobile Documents'), reason: 'personal cloud documents are sensitive' },
    { path: resolve(home, 'Desktop'), reason: 'personal files are outside the allowed project scope' },
    { path: resolve(home, 'Documents'), reason: 'personal files are outside the allowed project scope' },
    { path: resolve(home, 'Downloads'), reason: 'personal files are outside the allowed project scope' },
    { path: resolve(home, 'Pictures'), reason: 'personal files are outside the allowed project scope' },
    { path: resolve(home, 'Music'), reason: 'personal files are outside the allowed project scope' },
    { path: resolve(home, 'Movies'), reason: 'personal files are outside the allowed project scope' },
    { path: resolve(home, '.zsh_history'), reason: 'shell history is sensitive' },
    { path: resolve(home, '.bash_history'), reason: 'shell history is sensitive' },
  ];
}
