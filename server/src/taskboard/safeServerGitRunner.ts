import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { RepositoryWorkspaceGitCommand, RepositoryWorkspaceGitResult } from './repositoryWorkspaceSync.js';

const SAFE_GIT_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'credential.helper=',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'protocol.file.allow=never',
  'protocol.ext.allow=never',
] as const;

/**
 * The only child-process Git boundary for server-owned v3 repositories.
 * Configuration scopes are redirected away from the host and repository. The
 * explicit -c policy also wins on Git versions that do not yet honour
 * GIT_CONFIG_LOCAL.
 */
export function safeServerGitArgs(args: readonly string[]): string[] {
  return [...SAFE_GIT_CONFIG.flatMap((entry) => ['-c', entry]), ...args];
}

export function safeServerGitEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    HOME: '/nonexistent/integration-v3-control-plane',
    XDG_CONFIG_HOME: '/nonexistent/integration-v3-control-plane',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // Supported by the production Git build. This is intentionally set even
    // though older Git ignores it; all dangerous facilities are also pinned
    // above and network commands use an explicit canonical URL after `--`.
    GIT_CONFIG_LOCAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...overrides,
  };
}

export function runSafeServerGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult> {
  try {
    assertNoDangerousRepositoryConfig(command.cwd);
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

function assertNoDangerousRepositoryConfig(cwd: string): void {
  const config = findRepositoryConfig(cwd);
  if (!config) return;
  const text = readFileSync(config, 'utf8');
  // Includes can smuggle every forbidden setting from an attacker-controlled
  // path. URL rewriting is never needed because all network commands receive a
  // canonical URL explicitly.
  if (/^\s*\[(?:include|includeIf)\b/im.test(text)
    || /^\s*(?:pushInsteadOf|insteadOf)\s*=/im.test(text)
    || /^\s*(?:helper|hooksPath|fsmonitor)\s*=/im.test(text)
    || /^\s*(?:uploadpack|receivepack)\s*=/im.test(text)
    || /^\s*ext\s*=/im.test(text)) {
    throw new Error('unsafe repository Git configuration is forbidden');
  }
}

function findRepositoryConfig(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const dotGit = resolve(current, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return resolve(dotGit, 'config');
      const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(dotGit, 'utf8'));
      if (match) {
        const gitDir = resolve(current, match[1]!);
        const commonDirFile = resolve(gitDir, 'commondir');
        const commonDir = existsSync(commonDirFile)
          ? resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim())
          : gitDir;
        return resolve(commonDir, 'config');
      }
    }
    // Bare mirror.
    if (existsSync(resolve(current, 'HEAD')) && existsSync(resolve(current, 'config'))) return resolve(current, 'config');
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
