import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { canonicalGithubRepositoryUrl } from './repositoryProvider.js';
import type { RepositoryWorkspaceGitCommand, RepositoryWorkspaceGitResult } from './repositoryWorkspaceSync.js';

export interface IntegrationV3RepositoryProvisioningInput {
  controlledMirrorRoot: string;
  repository: TaskBoardRepositoryConfig;
  fetchEnvironment: Readonly<Record<string, string>>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
}

/** Provisions a minimal server-owned working mirror without reading Agent Git config. */
export async function provisionIntegrationV3RepositoryMirror(
  input: IntegrationV3RepositoryProvisioningInput,
): Promise<string> {
  const repositoryPath = resolve(
    input.controlledMirrorRoot,
    input.repository.repositoryId.replace(/[^A-Za-z0-9._-]/g, '_'),
  );
  if (existsSync(resolve(repositoryPath, '.git'))) return repositoryPath;
  await mkdir(input.controlledMirrorRoot, { recursive: true, mode: 0o700 });
  await mkdir(resolve(input.controlledMirrorRoot, '.worktrees'), { recursive: true, mode: 0o700 });
  const staging = `${repositoryPath}.provision-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await git(input, staging, ['init', `--initial-branch=${input.repository.baseBranch}`, '.']);
    const remoteUrl = canonicalGithubRepositoryUrl(input.repository);
    await git(input, staging, ['remote', 'add', 'origin', remoteUrl]);
    await git(input, staging, [
      'fetch', '--no-tags', '--prune', '--', remoteUrl,
      '+refs/heads/*:refs/remotes/origin/*',
    ], input.fetchEnvironment);
    const remoteBase = `refs/remotes/origin/${input.repository.baseBranch}`;
    await git(input, staging, ['update-ref', `refs/heads/${input.repository.baseBranch}`, remoteBase]);
    await git(input, staging, ['symbolic-ref', 'HEAD', `refs/heads/${input.repository.baseBranch}`]);
    await git(input, staging, ['reset', '--hard', remoteBase]);
    await rename(staging, repositoryPath);
    return repositoryPath;
  } catch (error) {
    if (existsSync(resolve(repositoryPath, '.git'))) return repositoryPath;
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function git(
  input: IntegrationV3RepositoryProvisioningInput,
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<void> {
  const result = await input.runGit({ cwd, args, ...(env ? { env } : {}) });
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
}
