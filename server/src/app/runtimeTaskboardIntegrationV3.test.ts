import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { resolveIntegrationV3RepositoryPaths } from './runtimeTaskboardIntegrationV3.js';

const repository: TaskBoardRepositoryConfig = {
  provider: 'github',
  repositoryId: 'github:acme/widget',
  owner: 'acme',
  name: 'widget',
  baseBranch: 'main',
  allowForkPullRequest: false,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveIntegrationV3RepositoryPaths', () => {
  it('skips a mismatched process repository and resolves the trusted agent project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-'));
    roots.push(root);
    const processCwd = createRepository(join(root, 'checkout'), 'https://github.com/other/widget.git');
    const agentCwd = join(root, 'agent');
    const repositoryPath = createRepository(
      join(agentCwd, 'projects', repository.name),
      'git@github.com:acme/widget.git',
    );

    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-1', { processCwd, agentCwd }))
      .resolves.toEqual({
        repositoryPath,
        worktreePath: resolve(agentCwd, 'projects', '.integration-v3-worktrees', 'candidate-1'),
      });
  });

  it('fails closed when no trusted root has the configured origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-'));
    roots.push(root);
    const processCwd = createRepository(join(root, 'checkout'), 'https://github.com/other/widget.git');

    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-2', {
      processCwd,
      agentCwd: join(root, 'agent'),
    })).resolves.toBeUndefined();
  });
});

function createRepository(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: path });
  return path;
}
