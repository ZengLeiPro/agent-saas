import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { RepositoryWorkspaceGitCommand, RepositoryWorkspaceGitResult } from './repositoryWorkspaceSync.js';

const SAFE_GIT_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.quotePath=false',
  'user.name=Integration Worker',
  'user.email=integration-worker@localhost',
  'credential.helper=',
  'credential.useHttpPath=true',
  'http.sslVerify=true',
  'http.proxy=',
  'http.extraHeader=',
  'http.followRedirects=false',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'protocol.file.allow=never',
  'protocol.ext.allow=never',
] as const;

const ALLOWED_ENV_OVERRIDES = new Set([
  'GIT_ASKPASS',
  'KY_GIT_PUSH_TOKEN',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_DATE',
]);
const ALLOWED_CORE_CONFIG = new Map<string, ReadonlySet<string>>([
  ['repositoryformatversion', new Set(['0'])],
  ['filemode', new Set(['true', 'false'])],
  ['bare', new Set(['true', 'false'])],
  ['logallrefupdates', new Set(['true', 'false'])],
]);
const ALLOWED_ORIGIN_FETCH = new Set([
  '+refs/heads/*:refs/remotes/origin/*',
  '+refs/*:refs/*',
]);
const CANONICAL_GITHUB_ORIGIN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

const FORBIDDEN_CALLER_GLOBAL_OPTIONS = [
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
] as const;

/** The only child-process Git boundary for server-owned v3 repositories. */
export function safeServerGitArgs(args: readonly string[]): string[] {
  for (const arg of args) {
    const forbidden = FORBIDDEN_CALLER_GLOBAL_OPTIONS.find((option) => (
      arg === option || (option.startsWith('--') && arg.startsWith(`${option}=`))
    ));
    if (forbidden) throw new Error(`unsafe Git global option is forbidden: ${forbidden}`);
  }
  return [...SAFE_GIT_CONFIG.flatMap((entry) => ['-c', entry]), ...args];
}

export function safeServerGitEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const allowed = Object.fromEntries(Object.entries(overrides).filter(([key]) => ALLOWED_ENV_OVERRIDES.has(key)));
  return {
    ...allowed,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    HOME: '/nonexistent/integration-v3-control-plane',
    XDG_CONFIG_HOME: '/nonexistent/integration-v3-control-plane',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_ALLOW_PROTOCOL: 'https',
  };
}

export function runSafeServerGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult> {
  try {
    assertSafeRepository(command.cwd);
  } catch (error) {
    return Promise.resolve({
      exitCode: 128,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    });
  }
  return new Promise((resolveResult) => execFile(
    'git',
    safeServerGitArgs(command.args),
    {
      cwd: command.cwd,
      env: safeServerGitEnvironment(command.env),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
    (error, stdout, stderr) => resolveResult({
      exitCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
        ? error.code
        : error ? 1 : 0,
      stdout,
      stderr,
    }),
  ));
}

/**
 * Parse repository discovery metadata without invoking Git, then validate the
 * real common-dir before Git can read any repository-controlled configuration.
 */
function assertSafeRepository(cwd: string): void {
  const repository = findRepository(cwd);
  // `git --version` is used by the health probe outside a repository.
  if (!repository) return;
  for (const path of [repository.gitDir, repository.commonDir]) assertOwnedPrivateDirectory(path);
  const config = resolve(repository.commonDir, 'config');
  if (!existsSync(config)) return;
  const configInfo = lstatSync(config);
  if (!configInfo.isFile() || configInfo.isSymbolicLink()) throw unsafeConfig();
  assertOwnedPrivate(configInfo.uid, configInfo.mode);
  assertAllowlistedLocalConfig(readFileSync(config, 'utf8'));
}

function assertAllowlistedLocalConfig(text: string): void {
  let section: 'core' | 'origin' | undefined;
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      const rawSection = sectionMatch[1]!.trim();
      section = rawSection.toLowerCase() === 'core'
        ? 'core'
        : /^remote\s+"origin"$/i.test(rawSection) ? 'origin' : undefined;
      if (!section) throw unsafeConfig();
      continue;
    }
    const keyValue = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!keyValue || !section) throw unsafeConfig();
    const key = keyValue[1]!.toLowerCase();
    const value = keyValue[2]!.trim();
    const identity = `${section}.${key}`;
    if (seen.has(identity)) throw unsafeConfig();
    if (section === 'core') {
      if (!ALLOWED_CORE_CONFIG.get(key)?.has(value.toLowerCase())) throw unsafeConfig();
    } else if (key === 'url') {
      if (!CANONICAL_GITHUB_ORIGIN.test(value)) throw unsafeConfig();
    } else if (key === 'fetch') {
      if (!ALLOWED_ORIGIN_FETCH.has(value)) throw unsafeConfig();
    } else throw unsafeConfig();
    seen.add(identity);
  }
}

function findRepository(start: string): { gitDir: string; commonDir: string } | undefined {
  let current = realpathSync(resolve(start));
  while (true) {
    const dotGit = resolve(current, '.git');
    if (existsSync(dotGit)) {
      const dotGitInfo = lstatSync(dotGit);
      if (dotGitInfo.isSymbolicLink()) throw unsafeConfig();
      let gitDir: string;
      if (dotGitInfo.isDirectory()) gitDir = realpathSync(dotGit);
      else {
        if (!dotGitInfo.isFile()) throw unsafeConfig();
        const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(dotGit, 'utf8'));
        if (!match) throw unsafeConfig();
        gitDir = realpathSync(resolve(current, match[1]!));
      }
      const commonDirFile = resolve(gitDir, 'commondir');
      let commonDir = gitDir;
      if (existsSync(commonDirFile)) {
        const info = lstatSync(commonDirFile);
        if (!info.isFile() || info.isSymbolicLink()) throw unsafeConfig();
        assertOwnedPrivate(info.uid, info.mode);
        const commonDirPath = readFileSync(commonDirFile, 'utf8').trim();
        if (!commonDirPath || commonDirPath.includes('\0')) throw unsafeConfig();
        commonDir = realpathSync(resolve(gitDir, commonDirPath));
      }
      return { gitDir, commonDir };
    }
    // Bare repositories are supported, but still receive the same strict config policy.
    if (existsSync(resolve(current, 'HEAD')) && existsSync(resolve(current, 'config'))) {
      const commonDir = realpathSync(current);
      return { gitDir: commonDir, commonDir };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function assertOwnedPrivateDirectory(path: string): void {
  const info = statSync(path);
  if (!info.isDirectory()) throw unsafeConfig();
  assertOwnedPrivate(info.uid, info.mode);
}

function assertOwnedPrivate(uid: number, mode: number): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) throw unsafeConfig();
  if ((mode & 0o022) !== 0) throw unsafeConfig();
}

function unsafeConfig(): Error {
  return new Error('unsafe repository Git configuration is forbidden');
}

export async function runSafeServerGitOrThrow(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await runSafeServerGit({ cwd, args, env });
  if (result.exitCode !== 0) throw new Error('safe server Git command failed');
  return result.stdout.trim();
}
