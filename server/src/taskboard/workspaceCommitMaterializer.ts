import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, opendir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_GIT_OUTPUT = 1024 * 1024;
const MAX_OBJECT_ENTRIES = 200_000;

export class WorkspaceCommitMaterializationError extends Error {
  constructor(public readonly code:
    | 'workspace_unavailable'
    | 'unsafe_git_metadata'
    | 'alternates_forbidden'
    | 'object_store_too_large'
    | 'object_missing'
    | 'merge_commit_forbidden'
    | 'parent_mismatch'
    | 'materialization_failed') {
    super(`Workspace commit materialization rejected: ${code}`);
    this.name = 'WorkspaceCommitMaterializationError';
  }
}

export interface MaterializedWorkspaceCommit {
  repositoryPath: string;
  commitOid: string;
}

/**
 * Imports one direct-parent commit from a bound user workspace without invoking Git in
 * that workspace. Source config, hooks, remotes and credential helpers are never read.
 * The callback sees a self-contained 0700 temporary bare repository; cleanup is unconditional.
 */
export async function withMaterializedWorkspaceCommit<T>(input: {
  workspaceRoot: string;
  repositoryName: string;
  commitOid: string;
  expectedOldOid: string;
  tempRoot?: string;
  onTemporaryDirectory?: (path: string) => void;
}, action: (materialized: MaterializedWorkspaceCommit) => Promise<T>): Promise<T> {
  if (!OID.test(input.commitOid) || !OID.test(input.expectedOldOid)) {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  const objectDirectory = await resolveWorkspaceObjectDirectory(input.workspaceRoot, input.repositoryName);
  const temporaryRoot = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'taskboard-work-push-'));
  const repositoryPath = join(temporaryRoot, 'repository.git');
  let materialized = false;
  try {
    input.onTemporaryDirectory?.(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    await runGit(temporaryRoot, ['init', '--bare', 'repository.git']);
    await chmod(repositoryPath, 0o700);
    const alternateEnv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory };
    await assertCommitGraph(repositoryPath, input.expectedOldOid, input.commitOid, alternateEnv);
    await runGit(repositoryPath, ['update-ref', 'refs/heads/candidate', input.commitOid], alternateEnv);
    await runGit(repositoryPath, ['repack', '-a', '-d'], alternateEnv, 30_000);
    await assertCommitGraph(repositoryPath, input.expectedOldOid, input.commitOid, {});
    await runGit(repositoryPath, ['fsck', '--full', '--no-dangling'], {}, 30_000);
    materialized = true;
    return await action({ repositoryPath, commitOid: input.commitOid });
  } catch (error) {
    if (materialized || error instanceof WorkspaceCommitMaterializationError) throw error;
    throw new WorkspaceCommitMaterializationError('materialization_failed');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function resolveWorkspaceObjectDirectory(workspaceRoot: string, repositoryName: string): Promise<string> {
  try {
    if (!isAbsolute(workspaceRoot) || !/^[A-Za-z0-9_.-]+$/.test(repositoryName)) throw new Error('invalid workspace binding');
    const rootInfo = await lstat(workspaceRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('unsafe workspace root');
    const root = await realpath(workspaceRoot);
    const candidates = [join(root, 'code', repositoryName), join(root, repositoryName), root];
    for (const candidate of candidates) {
      const objectDirectory = await resolveRepositoryObjectDirectory(root, candidate);
      if (objectDirectory) return objectDirectory;
    }
    throw new WorkspaceCommitMaterializationError('workspace_unavailable');
  } catch (error) {
    if (error instanceof WorkspaceCommitMaterializationError) throw error;
    throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
  }
}

async function resolveRepositoryObjectDirectory(workspaceRoot: string, candidate: string): Promise<string | undefined> {
  let rootInfo;
  try { rootInfo = await lstat(candidate); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('unsafe repository root');
  const root = await realpath(candidate);
  assertWithin(workspaceRoot, root);
  const dotGit = join(root, '.git');
  let dotGitInfo;
  try { dotGitInfo = await lstat(dotGit); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (dotGitInfo.isSymbolicLink()) throw new Error('symlink git dir');
  let gitDir: string;
  if (dotGitInfo.isDirectory()) {
    gitDir = await realpath(dotGit);
  } else if (dotGitInfo.isFile() && dotGitInfo.size <= 4096) {
    const match = /^gitdir:\s*(.+)\s*$/i.exec(await readFile(dotGit, 'utf8'));
    if (!match) throw new Error('invalid gitdir file');
    gitDir = await realpath(resolve(root, match[1]!));
  } else throw new Error('invalid git metadata');
  assertWithin(workspaceRoot, gitDir);
  await assertNoSymlinkPath(workspaceRoot, gitDir);

  const commonDirFile = join(gitDir, 'commondir');
  let commonDir = gitDir;
  try {
    const info = await lstat(commonDirFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('unsafe commondir');
    const value = (await readFile(commonDirFile, 'utf8')).trim();
    if (!value || value.includes('\0')) throw new Error('invalid commondir');
    commonDir = await realpath(resolve(gitDir, value));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  assertWithin(workspaceRoot, commonDir);
  await assertNoSymlinkPath(workspaceRoot, commonDir);
  const objectDirectory = await realpath(join(commonDir, 'objects'));
  assertWithin(workspaceRoot, objectDirectory);
  await assertNoSymlinkPath(workspaceRoot, objectDirectory);
  await assertSafeObjectStore(objectDirectory);
  return objectDirectory;
}

async function assertSafeObjectStore(root: string): Promise<void> {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_OBJECT_ENTRIES) throw new WorkspaceCommitMaterializationError('object_store_too_large');
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
      if (relative(root, path).split(/[\\/]/).join('/') === 'info/alternates') {
        throw new WorkspaceCommitMaterializationError('alternates_forbidden');
      }
      if (info.isDirectory()) pending.push(path);
    }
  }
}

async function assertCommitGraph(
  repositoryPath: string,
  expectedOldOid: string,
  commitOid: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    const oldType = (await runGit(repositoryPath, ['cat-file', '-t', expectedOldOid], env)).trim();
    const newType = (await runGit(repositoryPath, ['cat-file', '-t', commitOid], env)).trim();
    if (oldType !== 'commit' || newType !== 'commit') throw new Error('not commit');
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  let fields: string[];
  try {
    fields = (await runGit(repositoryPath, ['rev-list', '--parents', '-n', '1', commitOid], env)).trim().split(/\s+/);
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  if (fields.length > 2) throw new WorkspaceCommitMaterializationError('merge_commit_forbidden');
  if (fields.length !== 2 || fields[1] !== expectedOldOid) {
    throw new WorkspaceCommitMaterializationError('parent_mismatch');
  }
}

async function runGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeout = 15_000,
): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_GIT_OUTPUT,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C', LC_ALL: 'C', HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0', GIT_ALLOW_PROTOCOL: '',
        ...extraEnv,
      },
    });
    return result.stdout;
  } catch {
    throw new Error('controlled git command failed');
  }
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (!rel) return;
  let current = root;
  for (const segment of rel.split(/[\\/]/)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink path');
  }
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path escapes workspace');
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
