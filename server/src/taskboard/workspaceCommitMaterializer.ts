import { execFile, spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, open, opendir, readFile, realpath, rm } from 'node:fs/promises';
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
    | 'materialization_failed', public readonly stage?: string, cause?: unknown) {
    super(`Workspace commit materialization rejected: ${code}${stage ? ` at ${stage}` : ''}`, cause ? { cause } : undefined);
    this.name = 'WorkspaceCommitMaterializationError';
  }
}

export interface MaterializedWorkspaceCommit {
  repositoryPath: string;
  commitOid: string;
}

/**
 * Imports one single-parent commit from a bound user workspace without invoking Git in
 * that workspace. Source config, hooks, remotes and credential helpers are never read.
 * The callback sees a self-contained 0700 temporary bare repository; cleanup is unconditional.
 */
export async function withMaterializedWorkspaceCommit<T>(input: {
  workspaceRoot: string;
  repositoryName: string;
  commitOid: string;
  expectedOldOid: string;
  /** Immutable candidate revision base; permits a controlled rebase only when it diverged from expectedOldOid. */
  expectedBaseOid?: string;
  tempRoot?: string;
  onTemporaryDirectory?: (path: string) => void;
  /** Test synchronization point after the workspace object directory is descriptor-bound. */
  onWorkspaceObjectDirectoryBound?: (objectDirectory: string) => Promise<void> | void;
}, action: (materialized: MaterializedWorkspaceCommit) => Promise<T>): Promise<T> {
  if (!OID.test(input.commitOid) || !OID.test(input.expectedOldOid)
    || (input.expectedBaseOid !== undefined && !OID.test(input.expectedBaseOid))) {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  const temporaryRoot = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'taskboard-work-push-'));
  const repositoryPath = join(temporaryRoot, 'repository.git');
  let materialized = false;
  let workspaceObjectDirectory: BoundWorkspaceObjectDirectory | undefined;
  try {
    workspaceObjectDirectory = await bindWorkspaceObjectDirectory(input.workspaceRoot, input.repositoryName);
    input.onTemporaryDirectory?.(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    await runGit(temporaryRoot, ['init', '--bare', 'repository.git']);
    await chmod(repositoryPath, 0o700);
    // Never pass the mutable workspace pathname to Git. The child inherits the fstat-checked
    // directory at descriptor 3, so /proc/self/fd/3 remains the bound object store after rename.
    const alternateEnv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: '/proc/self/fd/3' };
    await input.onWorkspaceObjectDirectoryBound?.(workspaceObjectDirectory.path);
    await assertCommitGraph(
      repositoryPath, input.expectedOldOid, input.commitOid, input.expectedBaseOid,
      alternateEnv, workspaceObjectDirectory.handle.fd,
    );
    await runGit(
      repositoryPath, ['update-ref', 'refs/heads/candidate', input.commitOid], alternateEnv, 15_000,
      workspaceObjectDirectory.handle.fd,
    );
    await runGit(
      repositoryPath, ['update-ref', 'refs/taskboard/expected-old', input.expectedOldOid], alternateEnv, 15_000,
      workspaceObjectDirectory.handle.fd,
    );
    if (input.expectedBaseOid) {
      await runGit(
        repositoryPath, ['update-ref', 'refs/taskboard/expected-base', input.expectedBaseOid], alternateEnv, 15_000,
        workspaceObjectDirectory.handle.fd,
      );
    }
    await runGit(repositoryPath, ['repack', '-a', '-d'], alternateEnv, 30_000, workspaceObjectDirectory.handle.fd);
    await assertWorkspaceObjectDirectoryBinding(input.workspaceRoot, input.repositoryName, workspaceObjectDirectory);
    await assertCommitGraph(
      repositoryPath, input.expectedOldOid, input.commitOid, input.expectedBaseOid, {},
    );
    await runGit(repositoryPath, ['fsck', '--full', '--no-dangling'], {}, 30_000);
    materialized = true;
    return await action({ repositoryPath, commitOid: input.commitOid });
  } catch (error) {
    if (materialized || error instanceof WorkspaceCommitMaterializationError) throw error;
    throw new WorkspaceCommitMaterializationError('materialization_failed');
  } finally {
    await workspaceObjectDirectory?.handle.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export interface MaterializedCandidateObjects {
  repositoryName: string;
  baseOid: string;
  headOid: string;
  treeOid: string;
}

/**
 * Copies an exact, server-validated candidate subject into a bound workspace object store.
 * Candidate closure is first unpacked and verified in a server-owned temporary repository.
 * Workspace objects are never used to validate or construct that trusted snapshot.
 */
export async function materializeCandidateObjects(input: {
  sourceRepositoryPath: string;
  workspaceRoot: string;
  repositoryName: string;
  baseOid: string;
  headOid: string;
  treeOid: string;
  /** Test synchronization point after the candidate closure is isolated from its source path. */
  onTrustedCandidateMaterialized?: (repositoryPath: string) => Promise<void> | void;
  /** Test synchronization point after the target directory is bound by file descriptor. */
  onWorkspaceObjectDirectoryBound?: (objectDirectory: string) => Promise<void> | void;
}): Promise<MaterializedCandidateObjects> {
  if (![input.baseOid, input.headOid, input.treeOid].every((value) => OID.test(value))) {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  const sourceInfo = await lstat(input.sourceRepositoryPath).catch(() => undefined);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new WorkspaceCommitMaterializationError('materialization_failed');
  }
  const sourceRepositoryPath = await realpath(input.sourceRepositoryPath);
  // Deliberately use the server process temporary directory, never a caller-selected path.
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'taskboard-candidate-objects-'));
  let stage = 'temporary_repository';
  try {
    await chmod(temporaryRoot, 0o700);
    const trustedRepositoryPath = join(temporaryRoot, 'trusted.git');
    await runGit(temporaryRoot, ['init', '--bare', 'trusted.git']);
    await chmod(trustedRepositoryPath, 0o700);

    // Read the source path once to make a self-contained candidate-only pack. Any later
    // workspace rename or symlink substitution cannot affect the trusted repository.
    stage = 'source_connectivity';
    await assertCandidateObjects(sourceRepositoryPath, input.baseOid, input.headOid, input.treeOid, {});
    const sourcePackPath = join(temporaryRoot, 'source-candidate.pack');
    stage = 'source_pack';
    await runGitWithInputToFile(
      sourceRepositoryPath,
      ['pack-objects', '--stdout', '--revs'],
      `${input.headOid}\n${input.baseOid}\n`,
      sourcePackPath,
      {},
      120_000,
    );
    stage = 'trusted_unpack';
    await indexPack(trustedRepositoryPath, sourcePackPath);
    stage = 'trusted_connectivity';
    await assertCandidateObjects(trustedRepositoryPath, input.baseOid, input.headOid, input.treeOid, {});
    await input.onTrustedCandidateMaterialized?.(trustedRepositoryPath);

    // Always transfer from the trusted snapshot, even when the workspace already claims
    // to have the requested objects. This keeps target contents out of the trust decision.
    stage = 'target_binding';
    const targetObjectDirectory = await bindWorkspaceObjectDirectory(input.workspaceRoot, input.repositoryName);
    try {
      await input.onWorkspaceObjectDirectoryBound?.(targetObjectDirectory.path);
      const trustedPackPath = join(temporaryRoot, 'trusted-candidate.pack');
      stage = 'trusted_pack';
      await runGitWithInputToFile(
        trustedRepositoryPath,
        ['pack-objects', '--stdout', '--revs'],
        `${input.headOid}\n${input.baseOid}\n`,
        trustedPackPath,
        {},
        120_000,
      );
      const sinkRepositoryPath = join(temporaryRoot, 'sink.git');
      await runGit(temporaryRoot, ['init', '--bare', 'sink.git']);
      stage = 'target_unpack';
      // The child receives an inherited descriptor, not a workspace pathname. On Linux
      // /proc/self/fd/3 resolves in the child to exactly the directory fstat-checked above,
      // even if an attacker renames it or replaces its path with a symlink meanwhile.
      await indexPack(
        sinkRepositoryPath,
        trustedPackPath,
        { GIT_OBJECT_DIRECTORY: '/proc/self/fd/3' },
        targetObjectDirectory.handle.fd,
      );
      stage = 'final_binding';
      await assertWorkspaceObjectDirectoryBinding(input.workspaceRoot, input.repositoryName, targetObjectDirectory);
    } finally {
      await targetObjectDirectory.handle.close();
    }
    return {
      repositoryName: input.repositoryName,
      baseOid: input.baseOid,
      headOid: input.headOid,
      treeOid: input.treeOid,
    };
  } catch (error) {
    if (error instanceof WorkspaceCommitMaterializationError) {
      throw error.stage ? error : new WorkspaceCommitMaterializationError(error.code, stage, error);
    }
    throw new WorkspaceCommitMaterializationError('materialization_failed', stage, error);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface BoundWorkspaceObjectDirectory {
  path: string;
  device: number;
  inode: number;
  handle: Awaited<ReturnType<typeof open>>;
}

/**
 * Binds the validated object directory to an open directory descriptor. The inode comparison
 * catches a substitution between metadata validation and open(); subsequent Git runs receive
 * only the inherited descriptor through /proc/self/fd/3, never this mutable pathname.
 */
async function bindWorkspaceObjectDirectory(
  workspaceRoot: string,
  repositoryName: string,
): Promise<BoundWorkspaceObjectDirectory> {
  if (process.platform !== 'linux') throw new Error('descriptor-bound object directories require Linux');
  const path = await resolveWorkspaceObjectDirectory(workspaceRoot, repositoryName);
  const expected = await lstat(path);
  if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error('unsafe object directory');
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error('object directory changed during binding');
    }
    return { path, device: actual.dev, inode: actual.ino, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertWorkspaceObjectDirectoryBinding(
  workspaceRoot: string,
  repositoryName: string,
  expected: BoundWorkspaceObjectDirectory,
): Promise<void> {
  const path = await resolveWorkspaceObjectDirectory(workspaceRoot, repositoryName);
  const actual = await lstat(path);
  if (!actual.isDirectory() || actual.isSymbolicLink()
    || path !== expected.path || actual.dev !== expected.device || actual.ino !== expected.inode) {
    throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
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
  expectedBaseOid: string | undefined,
  env: Record<string, string>,
  inheritedDirectoryFd?: number,
): Promise<void> {
  try {
    const oldType = (await runGit(repositoryPath, ['cat-file', '-t', expectedOldOid], env, 15_000, inheritedDirectoryFd)).trim();
    const newType = (await runGit(repositoryPath, ['cat-file', '-t', commitOid], env, 15_000, inheritedDirectoryFd)).trim();
    const baseType = expectedBaseOid
      ? (await runGit(repositoryPath, ['cat-file', '-t', expectedBaseOid], env, 15_000, inheritedDirectoryFd)).trim()
      : 'commit';
    if (oldType !== 'commit' || newType !== 'commit' || baseType !== 'commit') throw new Error('not commit');
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  let fields: string[];
  try {
    fields = (await runGit(
      repositoryPath, ['rev-list', '--parents', '-n', '1', commitOid], env, 15_000, inheritedDirectoryFd,
    )).trim().split(/\s+/);
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  if (fields.length > 2) throw new WorkspaceCommitMaterializationError('merge_commit_forbidden');
  if (fields.length !== 2) throw new WorkspaceCommitMaterializationError('parent_mismatch');
  const parentOid = fields[1];
  if (parentOid === expectedOldOid) return;
  if (!expectedBaseOid || parentOid !== expectedBaseOid || expectedBaseOid === expectedOldOid) {
    throw new WorkspaceCommitMaterializationError('parent_mismatch');
  }
  try {
    const mergeBase = (await runGit(
      repositoryPath, ['merge-base', expectedBaseOid, expectedOldOid], env, 15_000, inheritedDirectoryFd,
    )).trim();
    if (!OID.test(mergeBase) || mergeBase === expectedBaseOid) {
      throw new WorkspaceCommitMaterializationError('parent_mismatch');
    }
  } catch (error) {
    if (error instanceof WorkspaceCommitMaterializationError) throw error;
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
}


async function assertCandidateObjects(
  cwd: string,
  baseOid: string,
  headOid: string,
  treeOid: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    if ((await runGit(cwd, ['cat-file', '-t', baseOid], env)).trim() !== 'commit') throw new Error('base');
    if ((await runGit(cwd, ['cat-file', '-t', headOid], env)).trim() !== 'commit') throw new Error('head');
    const actualTree = (await runGit(cwd, ['rev-parse', `${headOid}^{tree}`], env)).trim();
    if (actualTree !== treeOid) throw new Error('tree');
    await runGit(cwd, ['fsck', '--connectivity-only', '--no-dangling', headOid, baseOid], env, 30_000);
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
}

async function indexPack(
  repositoryPath: string,
  packPath: string,
  env: Record<string, string> = {},
  inheritedDirectoryFd?: number,
): Promise<void> {
  const hash = await runGitWithFileInput(
    repositoryPath,
    ['index-pack', '--stdin'],
    packPath,
    env,
    120_000,
    inheritedDirectoryFd,
  );
  if (!/^(?:pack\t)?(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error('invalid pack hash');
}

async function runGitWithInput(
  cwd: string,
  args: string[],
  input: string,
  extraEnv: Record<string, string> = {},
  timeout = 30_000,
): Promise<string> {
  return runSpawnedGit(cwd, args, extraEnv, timeout, (child) => child.stdin!.end(input));
}

async function runGitWithInputToFile(
  cwd: string,
  args: string[],
  input: string,
  outputPath: string,
  extraEnv: Record<string, string> = {},
  timeout = 30_000,
): Promise<void> {
  const output = await open(outputPath, 'wx', 0o600);
  const child = spawn('git', args, {
    cwd,
    stdio: ['pipe', output.fd, 'pipe'],
    env: safeGitEnvironment(cwd, extraEnv),
  });
  let stderr = '';
  let timedOut = false;
  child.stdin!.on('error', () => undefined);
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderr.length < MAX_GIT_OUTPUT) stderr += chunk.slice(0, MAX_GIT_OUTPUT - stderr.length);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);
  try {
    child.stdin!.end(input);
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveExit(code ?? -1));
    });
    if (exitCode !== 0) {
      throw new Error(`controlled git command failed: ${timedOut ? `timed out after ${timeout}ms` : stderr.trim()}`);
    }
  } finally {
    clearTimeout(timer);
    await output.close();
  }
}

async function runGitWithFileInput(
  cwd: string,
  args: string[],
  inputPath: string,
  extraEnv: Record<string, string> = {},
  timeout = 30_000,
  inheritedDirectoryFd?: number,
): Promise<string> {
  return runSpawnedGit(
    cwd, args, extraEnv, timeout, (child) => createReadStream(inputPath).pipe(child.stdin!), inheritedDirectoryFd,
  );
}

async function runSpawnedGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string>,
  timeout: number,
  provideInput: (child: ReturnType<typeof spawn>) => void,
  inheritedDirectoryFd?: number,
): Promise<string> {
  if (inheritedDirectoryFd !== undefined
    && (process.platform !== 'linux' || !Number.isSafeInteger(inheritedDirectoryFd) || inheritedDirectoryFd < 0)) {
    throw new Error('invalid descriptor-bound Git object directory');
  }
  const child = spawn('git', args, {
    cwd,
    stdio: inheritedDirectoryFd === undefined
      ? ['pipe', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'pipe', inheritedDirectoryFd],
    env: safeGitEnvironment(cwd, extraEnv),
  });
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdoutStream || !stderrStream) throw new Error('controlled git command missing output streams');
  let stdout = '';
  let stderr = '';
  stdoutStream.setEncoding('utf8');
  stderrStream.setEncoding('utf8');
  stdoutStream.on('data', (chunk: string) => {
    if (stdout.length < MAX_GIT_OUTPUT) stdout += chunk.slice(0, MAX_GIT_OUTPUT - stdout.length);
  });
  stderrStream.on('data', (chunk: string) => {
    if (stderr.length < MAX_GIT_OUTPUT) stderr += chunk.slice(0, MAX_GIT_OUTPUT - stderr.length);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    provideInput(child);
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveExit(code ?? -1));
    });
    if (exitCode !== 0) throw new Error(`controlled git command failed: ${stderr.trim()}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

function safeGitEnvironment(cwd: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C', LC_ALL: 'C', HOME: cwd,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0', GIT_ALLOW_PROTOCOL: '',
    ...extraEnv,
  };
}

async function runGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeout = 15_000,
  inheritedDirectoryFd?: number,
): Promise<string> {
  if (inheritedDirectoryFd !== undefined) {
    return runSpawnedGit(cwd, args, extraEnv, timeout, (child) => child.stdin!.end(), inheritedDirectoryFd);
  }
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_GIT_OUTPUT,
      env: safeGitEnvironment(cwd, extraEnv),
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
