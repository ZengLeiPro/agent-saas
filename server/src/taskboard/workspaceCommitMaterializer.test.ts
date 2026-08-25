import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeCandidateObjects, withMaterializedWorkspaceCommit } from './workspaceCommitMaterializer.js';

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

describe('materializeCandidateObjects', () => {
  it('imports exact candidate objects without changing workspace refs, index or worktree', async () => {
    const source = await repository();
    const treeOid = await git(source.root, ['rev-parse', `${source.newOid}^{tree}`]);
    const workspace = await mkdtemp(join(tmpdir(), 'candidate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'code', 'agent-saas');
    await mkdir(join(workspace, 'code'), { recursive: true });
    await mkdir(target);
    await git(target, ['init']);
    await writeFile(join(target, 'local.txt'), 'untouched\n');
    const headBefore = await readFile(join(target, '.git', 'HEAD'), 'utf8');

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.oldOid,
      headOid: source.newOid,
      treeOid,
    })).resolves.toMatchObject({ baseOid: source.oldOid, headOid: source.newOid, treeOid });

    expect(await git(target, ['cat-file', '-t', source.oldOid])).toBe('commit');
    expect(await git(target, ['cat-file', '-t', source.newOid])).toBe('commit');
    expect(await readFile(join(target, '.git', 'HEAD'), 'utf8')).toBe(headBefore);
    expect(await git(target, ['status', '--short'])).toBe('?? local.txt');
    expect(await git(target, ['for-each-ref', '--format=%(refname)'])).toBe('');

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.oldOid,
      headOid: source.newOid,
      treeOid,
    })).resolves.toMatchObject({ headOid: source.newOid });
  });

  it.each(['pack', 'idx'] as const)('rejects a pre-existing damaged same-name %s file', async (extension) => {
    const source = await repository();
    const treeOid = await git(source.root, ['rev-parse', `${source.newOid}^{tree}`]);
    const workspace = await mkdtemp(join(tmpdir(), 'damaged-pack-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);
    const input = {
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.oldOid,
      headOid: source.newOid,
      treeOid,
    };
    await materializeCandidateObjects(input);

    const packDirectory = join(target, '.git', 'objects', 'pack');
    const name = (await readdir(packDirectory)).find((entry) => entry.endsWith(`.${extension}`));
    expect(name).toBeDefined();
    const damaged = join(packDirectory, name!);
    await writeFile(damaged, 'pre-existing damaged same-name sentinel\n');

    await expect(materializeCandidateObjects(input)).rejects.toMatchObject({
      code: 'unsafe_git_metadata', stage: 'target_publish',
    });
    expect(await readFile(damaged, 'utf8')).toBe('pre-existing damaged same-name sentinel\n');
  });

  it('ignores a poisoned target loose object because target objects are never Git inputs', async () => {
    const source = await repository();
    await git(source.root, ['commit', '--allow-empty', '-m', 'candidate']);
    const headOid = await git(source.root, ['rev-parse', 'HEAD']);
    const treeOid = await git(source.root, ['rev-parse', `${headOid}^{tree}`]);
    const workspace = await mkdtemp(join(tmpdir(), 'poisoned-candidate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);
    await git(target, ['fetch', '--no-tags', source.root, source.newOid]);

    const commit = `${await git(source.root, ['cat-file', 'commit', headOid])}\npoison\n`;
    const raw = Buffer.concat([
      Buffer.from(`commit ${Buffer.byteLength(commit)}\0`),
      Buffer.from(commit),
    ]);
    const objectDirectory = join(target, '.git', 'objects', headOid.slice(0, 2));
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(join(objectDirectory, headOid.slice(2)), deflateSync(raw));

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.newOid,
      headOid,
      treeOid,
    })).resolves.toMatchObject({ baseOid: source.newOid, headOid, treeOid });
  });

  it('imports both exact tips when the authoritative base advanced beyond the PR head', async () => {
    const source = await repository();
    const baseBranch = await git(source.root, ['branch', '--show-current']);
    await git(source.root, ['checkout', '-b', 'candidate', source.oldOid]);
    await writeFile(join(source.root, 'candidate.txt'), 'candidate\n');
    await git(source.root, ['add', 'candidate.txt']);
    await git(source.root, ['commit', '-m', 'candidate']);
    const headOid = await git(source.root, ['rev-parse', 'HEAD']);
    const treeOid = await git(source.root, ['rev-parse', `${headOid}^{tree}`]);
    await git(source.root, ['checkout', baseBranch]);
    await writeFile(join(source.root, 'base.txt'), 'advanced base\n');
    await git(source.root, ['add', 'base.txt']);
    await git(source.root, ['commit', '-m', 'advanced base']);
    const baseOid = await git(source.root, ['rev-parse', 'HEAD']);
    await expect(git(source.root, ['merge-base', '--is-ancestor', baseOid, headOid])).rejects.toThrow();

    const workspace = await mkdtemp(join(tmpdir(), 'diverged-candidate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);
    await git(target, ['fetch', '--no-tags', source.root, source.oldOid]);

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid,
      headOid,
      treeOid,
    })).resolves.toMatchObject({ baseOid, headOid, treeOid });
    expect(await git(target, ['cat-file', '-t', baseOid])).toBe('commit');
    expect(await git(target, ['cat-file', '-t', headOid])).toBe('commit');
    await expect(git(target, ['fsck', '--connectivity-only', '--no-dangling', baseOid, headOid])).resolves.toBe('');
  });

  it('uses the trusted candidate snapshot after a source symlink replacement', async () => {
    const source = await repository();
    const replacement = await repository();
    const treeOid = await git(source.root, ['rev-parse', `${source.newOid}^{tree}`]);
    const workspace = await mkdtemp(join(tmpdir(), 'candidate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);
    const movedSource = `${source.root}-trusted-snapshot`;

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.oldOid,
      headOid: source.newOid,
      treeOid,
      onTrustedCandidateMaterialized: async (trustedRepositoryPath) => {
        expect((await stat(trustedRepositoryPath)).mode & 0o777).toBe(0o700);
        await rename(source.root, movedSource);
        roots.push(movedSource);
        await symlink(replacement.root, source.root);
      },
    })).resolves.toMatchObject({ baseOid: source.oldOid, headOid: source.newOid, treeOid });

    expect(await git(target, ['cat-file', '-t', source.oldOid])).toBe('commit');
    expect(await git(target, ['cat-file', '-t', source.newOid])).toBe('commit');
  });

  it('does not import objects outside the requested base/head closure', async () => {
    const source = await repository();
    await git(source.root, ['checkout', '-b', 'outside', source.oldOid]);
    await writeFile(join(source.root, 'outside.txt'), 'outside closure\n');
    await git(source.root, ['add', 'outside.txt']);
    await git(source.root, ['commit', '-m', 'outside candidate closure']);
    const outsideOid = await git(source.root, ['rev-parse', 'HEAD']);
    const treeOid = await git(source.root, ['rev-parse', `${source.newOid}^{tree}`]);
    const workspace = await mkdtemp(join(tmpdir(), 'closure-candidate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);

    await materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.oldOid,
      headOid: source.newOid,
      treeOid,
    });

    await expect(git(target, ['cat-file', '-e', `${outsideOid}^{commit}`])).rejects.toThrow();
  });

  it('fails closed without touching sentinels when objects/pack or info/alternates changes after binding', async () => {
    const source = await repository();
    const treeOid = await git(source.root, ['rev-parse', `${source.newOid}^{tree}`]);
    const workspace = await mkdtemp(join(tmpdir(), 'raced-candidate-workspace-'));
    const sentinel = await mkdtemp(join(tmpdir(), 'candidate-object-sentinel-'));
    roots.push(workspace, sentinel);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);
    const sentinelMarker = join(sentinel, 'sentinel');
    await writeFile(sentinelMarker, 'must stay untouched\n');

    const objectDirectory = join(target, '.git', 'objects');
    const packDirectory = join(objectDirectory, 'pack');
    const movedPackDirectory = join(objectDirectory, 'pack-before-race');
    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root, workspaceRoot: workspace, repositoryName: 'agent-saas',
      baseOid: source.oldOid, headOid: source.newOid, treeOid,
      onWorkspaceObjectDirectoryBound: async (boundPath) => {
        expect(boundPath).toBe(objectDirectory);
        await rename(packDirectory, movedPackDirectory);
        await symlink(sentinel, packDirectory);
      },
    })).rejects.toMatchObject({ code: 'materialization_failed', stage: 'target_binding' });
    expect(await readFile(sentinelMarker, 'utf8')).toBe('must stay untouched\n');
    await rm(packDirectory);
    await rename(movedPackDirectory, packDirectory);

    const detachedPackDirectory = join(objectDirectory, 'pack-detached-after-bind');
    const replacementMarker = 'replacement-directory-sentinel';
    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root, workspaceRoot: workspace, repositoryName: 'agent-saas',
      baseOid: source.oldOid, headOid: source.newOid, treeOid,
      onWorkspacePackDirectoryBound: async (boundPath) => {
        expect(boundPath).toBe(packDirectory);
        await rename(packDirectory, detachedPackDirectory);
        await mkdir(packDirectory);
        await writeFile(join(packDirectory, replacementMarker), 'must stay untouched\n');
      },
    })).rejects.toMatchObject({ code: 'unsafe_git_metadata', stage: 'final_binding' });
    expect(await readdir(packDirectory)).toEqual([replacementMarker]);
    expect(await readFile(join(packDirectory, replacementMarker), 'utf8')).toBe('must stay untouched\n');
    await rm(packDirectory, { recursive: true });
    await rename(detachedPackDirectory, packDirectory);

    const alternates = join(objectDirectory, 'info', 'alternates');
    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root, workspaceRoot: workspace, repositoryName: 'agent-saas',
      baseOid: source.oldOid, headOid: source.newOid, treeOid,
      onWorkspaceObjectDirectoryBound: async () => {
        await symlink(sentinel, alternates);
      },
    })).rejects.toMatchObject({ code: 'unsafe_git_metadata', stage: 'final_binding' });
    expect(await readFile(sentinelMarker, 'utf8')).toBe('must stay untouched\n');
    await rm(alternates);
  });

  it('rejects source info/alternates before any Git command can consume it', async () => {
    const source = await repository();
    const treeOid = await git(source.root, ['rev-parse', `${source.newOid}^{tree}`]);
    const sentinel = await mkdtemp(join(tmpdir(), 'source-alternate-sentinel-'));
    roots.push(sentinel);
    const marker = join(sentinel, 'sentinel');
    await writeFile(marker, 'must stay untouched\n');
    await mkdir(join(source.root, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(join(source.root, '.git', 'objects', 'info', 'alternates'), `${sentinel}\n`);
    const workspace = await mkdtemp(join(tmpdir(), 'source-alternate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root, workspaceRoot: workspace, repositoryName: 'agent-saas',
      baseOid: source.oldOid, headOid: source.newOid, treeOid,
    })).rejects.toMatchObject({ code: 'alternates_forbidden' });
    expect(await readFile(marker, 'utf8')).toBe('must stay untouched\n');
  });

  it('rejects an unverified candidate tree before dispatch', async () => {
    const source = await repository();
    const workspace = await mkdtemp(join(tmpdir(), 'candidate-workspace-'));
    roots.push(workspace);
    const target = join(workspace, 'agent-saas');
    await mkdir(target);
    await git(target, ['init']);

    await expect(materializeCandidateObjects({
      sourceRepositoryPath: source.root,
      workspaceRoot: workspace,
      repositoryName: 'agent-saas',
      baseOid: source.oldOid,
      headOid: source.newOid,
      treeOid: 'f'.repeat(40),
    })).rejects.toMatchObject({ code: 'object_missing' });
  });
});

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

  it('fails before Git reads a workspace pack or alternates replaced after binding', async () => {
    const source = await repository();
    const sentinel = await mkdtemp(join(tmpdir(), 'workspace-read-sentinel-'));
    roots.push(sentinel);
    const marker = join(sentinel, 'sentinel');
    await writeFile(marker, 'must stay untouched\n');
    const objectDirectory = join(source.root, '.git', 'objects');
    const packDirectory = join(objectDirectory, 'pack');
    const movedPackDirectory = join(objectDirectory, 'pack-before-race');

    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository',
      expectedOldOid: source.oldOid, commitOid: source.newOid,
      onWorkspaceObjectDirectoryBound: async () => {
        await rename(packDirectory, movedPackDirectory);
        await symlink(sentinel, packDirectory);
      },
    }, async () => undefined)).rejects.toMatchObject({ code: 'unsafe_git_metadata' });
    expect(await readFile(marker, 'utf8')).toBe('must stay untouched\n');
    await rm(packDirectory);
    await rename(movedPackDirectory, packDirectory);

    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root, repositoryName: 'repository',
      expectedOldOid: source.oldOid, commitOid: source.newOid,
      onWorkspaceObjectDirectoryBound: async () => {
        await symlink(sentinel, join(objectDirectory, 'info', 'alternates'));
      },
    }, async () => undefined)).rejects.toMatchObject({ code: 'alternates_forbidden' });
    expect(await readFile(marker, 'utf8')).toBe('must stay untouched\n');
    await rm(join(objectDirectory, 'info', 'alternates'));
  });

  it('materializes a controlled rebase while retaining the diverged old head for exact lease checks', async () => {
    const source = await repository();
    const oldHeadOid = source.newOid;
    await git(source.root, ['checkout', '--detach', source.oldOid]);
    await writeFile(join(source.root, 'base.txt'), 'advanced base\n');
    await git(source.root, ['add', 'base.txt']);
    await git(source.root, ['commit', '-m', 'advanced base']);
    const baseOid = await git(source.root, ['rev-parse', 'HEAD']);
    await writeFile(join(source.root, 'file.txt'), 'rebased candidate\n');
    await git(source.root, ['commit', '-am', 'rebased candidate']);
    const commitOid = await git(source.root, ['rev-parse', 'HEAD']);

    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root,
      repositoryName: 'repository',
      expectedOldOid: oldHeadOid,
      expectedBaseOid: baseOid,
      commitOid,
    }, async ({ repositoryPath }) => {
      expect(await git(repositoryPath, ['rev-parse', `${commitOid}^`])).toBe(baseOid);
      expect(await git(repositoryPath, ['rev-parse', 'refs/taskboard/expected-old'])).toBe(oldHeadOid);
      expect(await git(repositoryPath, ['merge-base', baseOid, oldHeadOid])).toBe(source.oldOid);
    })).resolves.toBeUndefined();
  });

  it('rejects a rebase rewrite when the immutable base already belongs to the old head history', async () => {
    const source = await repository();
    await git(source.root, ['checkout', '--detach', source.oldOid]);
    await writeFile(join(source.root, 'rewrite.txt'), 'rewrite\n');
    await git(source.root, ['add', 'rewrite.txt']);
    await git(source.root, ['commit', '-m', 'unnecessary rewrite']);
    const commitOid = await git(source.root, ['rev-parse', 'HEAD']);

    await expect(withMaterializedWorkspaceCommit({
      workspaceRoot: source.root,
      repositoryName: 'repository',
      expectedOldOid: source.newOid,
      expectedBaseOid: source.oldOid,
      commitOid,
    }, async () => undefined)).rejects.toMatchObject({ code: 'parent_mismatch' });
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
