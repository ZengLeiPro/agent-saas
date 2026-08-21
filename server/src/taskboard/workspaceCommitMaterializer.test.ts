import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { withMaterializedWorkspaceCommit } from './workspaceCommitMaterializer.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-commit-source-'));
  roots.push(root);
  await git(root, ['init']);
  await writeFile(join(root, 'file.txt'), 'one\n');
  await git(root, ['add', 'file.txt']);
  await git(root, ['commit', '-m', 'old']);
  const oldOid = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(join(root, 'file.txt'), 'two\n');
  await git(root, ['commit', '-am', 'new']);
  const newOid = await git(root, ['rev-parse', 'HEAD']);
  return { root, oldOid, newOid };
}

describe('withMaterializedWorkspaceCommit', () => {
  it('materializes a real direct-parent commit and removes alternate access before callback', async () => {
    const source = await repository();
    let temporaryRoot = '';
    const result = await withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository',
      expectedOldOid: source.oldOid,
      commitOid: source.newOid,
      onTemporaryDirectory: (path) => { temporaryRoot = path; },
    }, async ({ repositoryPath }) => {
      expect((await stat(repositoryPath)).mode & 0o777).toBe(0o700);
      expect(await git(repositoryPath, ['rev-parse', 'refs/heads/candidate'])).toBe(source.newOid);
      expect(await git(repositoryPath, ['rev-parse', `${source.newOid}^`])).toBe(source.oldOid);
      await expect(readFile(join(repositoryPath, 'objects', 'info', 'alternates'), 'utf8')).rejects.toThrow();
      return 'pushed';
    });
    expect(result).toBe('pushed');
    await expect(readFile(join(temporaryRoot, 'repository.git', 'HEAD'), 'utf8')).rejects.toThrow();
  });

  it('resolves the authoritative repository below the shared workspace root', async () => {
    const source = await repository();
    const workspace = await mkdtemp(join(tmpdir(), 'workspace-root-'));
    roots.push(workspace);
    const repositoryPath = join(workspace, 'code', 'agent-saas');
    await mkdir(join(workspace, 'code'), { recursive: true });
    await rename(source.root, repositoryPath);
    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      expectedOldOid: source.oldOid,
      commitOid: source.newOid,
    }, async ({ commitOid }) => commitOid)).resolves.toBe(source.newOid);
  });

  it('rejects alternates and symlinked object stores', async () => {
    const alternate = await repository();
    await mkdir(join(alternate.root, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(join(alternate.root, '.git', 'objects', 'info', 'alternates'), '/tmp/evil\n');
    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: alternate.root, repositoryName: 'repository', expectedOldOid: alternate.oldOid, commitOid: alternate.newOid,
    }, async () => undefined)).rejects.toMatchObject({ code: 'alternates_forbidden' });

    const linked = await repository();
    const outside = await mkdtemp(join(tmpdir(), 'workspace-objects-outside-'));
    roots.push(outside);
    await rm(join(linked.root, '.git', 'objects'), { recursive: true });
    await symlink(outside, join(linked.root, '.git', 'objects'));
    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: linked.root, repositoryName: 'repository', expectedOldOid: linked.oldOid, commitOid: linked.newOid,
    }, async () => undefined)).rejects.toMatchObject({ code: 'unsafe_git_metadata' });
  });

  it('rejects merge commits and commits whose unique parent is not authoritative', async () => {
    const source = await repository();
    const mainBranch = await git(source.root, ['branch', '--show-current']);
    await git(source.root, ['checkout', '-b', 'side', source.oldOid]);
    await writeFile(join(source.root, 'side.txt'), 'side\n');
    await git(source.root, ['add', 'side.txt']);
    await git(source.root, ['commit', '-m', 'side']);
    await git(source.root, ['merge', '--no-ff', mainBranch, '-m', 'merge']);
    const mergeOid = await git(source.root, ['rev-parse', 'HEAD']);
    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository', expectedOldOid: source.oldOid, commitOid: mergeOid,
    }, async () => undefined)).rejects.toMatchObject({ code: 'merge_commit_forbidden' });

    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository', expectedOldOid: source.oldOid, commitOid: source.newOid,
    }, async () => undefined)).resolves.toBeUndefined();
    await git(source.root, ['checkout', mainBranch]);
    await writeFile(join(source.root, 'file.txt'), 'three\n');
    await git(source.root, ['commit', '-am', 'third']);
    const thirdOid = await git(source.root, ['rev-parse', 'HEAD']);
    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository', expectedOldOid: source.oldOid, commitOid: thirdOid,
    }, async () => undefined)).rejects.toMatchObject({ code: 'parent_mismatch' });
  });

  it('cleans the temporary repository when the controlled push callback fails', async () => {
    const source = await repository();
    let temporaryRoot = '';
    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository',
      expectedOldOid: source.oldOid,
      commitOid: source.newOid,
      onTemporaryDirectory: (path) => { temporaryRoot = path; },
    }, async () => { throw new Error('provider failed'); })).rejects.toThrow('provider failed');
    await expect(readFile(join(temporaryRoot, 'repository.git', 'HEAD'), 'utf8')).rejects.toThrow();
  });
});
