import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { resolveIntegrationV3RepositoryPaths } from './runtimeTaskboardIntegrationV3.js';

const repository: TaskBoardRepositoryConfig = {
  provider: 'github', repositoryId: 'github:acme/widget', owner: 'acme', name: 'widget',
  baseBranch: 'main', allowForkPullRequest: false,
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('resolveIntegrationV3RepositoryPaths', () => {
  it('uses only a server-owned controlled mirror and never an Agent checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = createRepository(join(mirrorRoot, 'github_acme_widget'), 'https://github.com/acme/widget.git');
    createRepository(join(root, 'agent/projects/widget'), 'https://github.com/acme/widget.git');
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-1', {
      processCwd: root, agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toEqual({
      repositoryPath, worktreePath: resolve(mirrorRoot, '.worktrees', 'candidate-1'),
    });
  });

  it.each([
    'https://evil.example/path/github.com/acme/widget',
    'https://github.com.evil.example/acme/widget.git',
    'https://github.com:443/acme/widget.git?x=1',
    'https://user@github.com/acme/widget.git',
  ])('strictly rejects spoofed remote %s', async (origin) => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    createRepository(join(mirrorRoot, 'github_acme_widget'), origin);
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-2', {
      processCwd: root, agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();
  });

  it('fails closed when no controlled mirror capability is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    createRepository(join(root, 'agent/projects/widget'), 'https://github.com/acme/widget.git');
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-3', {
      processCwd: root, agentCwd: join(root, 'agent'),
    })).resolves.toBeUndefined();
  });
});

function createRepository(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: path });
  return path;
}
