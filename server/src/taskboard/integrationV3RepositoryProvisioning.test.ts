import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { provisionIntegrationV3RepositoryMirror } from './integrationV3RepositoryProvisioning.js';

const run = promisify(execFile);
const remoteUrl = 'https://github.com/acme/private-repo.git';

describe('provisionIntegrationV3RepositoryMirror', () => {
  it('creates a clean minimal mirror with all branch objects and reuses it idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'integration-v3-provision-'));
    const source = join(root, 'source');
    const mirrors = join(root, 'mirrors');
    await git(root, ['init', '--initial-branch=main', source]);
    await git(source, ['config', 'user.name', 'Test']);
    await git(source, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(source, 'base.txt'), 'base\n');
    await git(source, ['add', '.']);
    await git(source, ['commit', '-m', 'base']);
    await git(source, ['checkout', '-b', 'feature']);
    await writeFile(join(source, 'feature.txt'), 'feature\n');
    await git(source, ['add', '.']);
    await git(source, ['commit', '-m', 'feature']);
    const featureOid = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(source, ['checkout', 'main']);
    const commands: string[][] = [];
    const runGit = vi.fn(async (command: { cwd: string; args: readonly string[]; env?: Readonly<Record<string, string>> }) => {
      const args = [...command.args];
      commands.push(args);
      const remoteIndex = args.indexOf(remoteUrl);
      if (remoteIndex >= 0 && args[0] === 'fetch') args[remoteIndex] = source;
      const result = await run('git', args, { cwd: command.cwd, env: { ...process.env, ...command.env } });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    });
    try {
      const repository = {
        provider: 'github' as const, repositoryId: 'github:kaiyan:acme/private-repo',
        owner: 'acme', name: 'private-repo', baseBranch: 'main', allowForkPullRequest: false,
      } as const;
      const repositoryPath = await provisionIntegrationV3RepositoryMirror({
        controlledMirrorRoot: mirrors, repository, fetchEnvironment: { GIT_ASKPASS: '/askpass' }, runGit,
      });
      expect((await git(repositoryPath, ['remote', 'get-url', 'origin'])).stdout.trim()).toBe(remoteUrl);
      expect((await git(repositoryPath, ['cat-file', '-t', featureOid])).stdout.trim()).toBe('commit');
      expect((await git(repositoryPath, ['status', '--porcelain'])).stdout).toBe('');
      const before = commands.length;
      await provisionIntegrationV3RepositoryMirror({
        controlledMirrorRoot: mirrors, repository, fetchEnvironment: {}, runGit,
      });
      expect(commands).toHaveLength(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, args: string[]) {
  return run('git', args, { cwd });
}
