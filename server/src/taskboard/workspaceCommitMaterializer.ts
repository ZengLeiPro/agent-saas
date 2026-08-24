import { execFile, spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_GIT_OUTPUT = 1024 * 1024;
const MAX_OBJECT_ENTRIES = 200_000;
const COPY_BUFFER_SIZE = 64 * 1024;

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
 * Imports a single-parent commit from a user workspace without ever executing Git against
 * its mutable object store. Objects are copied through no-follow Linux descriptors into a
 * server-owned temporary bare repository before Git validates or reads them.
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
  if (process.platform !== 'linux') throw new WorkspaceCommitMaterializationError('materialization_failed', 'linux_required');

  const temporaryRoot = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'taskboard-work-push-'));
  const repositoryPath = join(temporaryRoot, 'repository.git');
  let materialized = false;
  let workspaceObjectDirectory: BoundObjectDirectory | undefined;
  try {
    await chmod(temporaryRoot, 0o700);
    await runGit(temporaryRoot, ['init', '--bare', 'repository.git']);
    await chmod(repositoryPath, 0o700);

    workspaceObjectDirectory = await bindWorkspaceObjectDirectory(input.workspaceRoot, input.repositoryName);
    input.onTemporaryDirectory?.(temporaryRoot);
    await input.onWorkspaceObjectDirectoryBound?.(workspaceObjectDirectory.path);

    // This is the sole workspace-object operation after binding. It is filesystem copying
    // through O_NOFOLLOW descriptors; all later Git commands use repositoryPath only.
    await copyBoundObjectStore(workspaceObjectDirectory.handle, join(repositoryPath, 'objects'));
    await assertSafeObjectStore(join(repositoryPath, 'objects'));
    await workspaceObjectDirectory.handle.close();
    workspaceObjectDirectory = undefined;

    await assertCommitGraph(repositoryPath, input.expectedOldOid, input.commitOid, input.expectedBaseOid);
    await runGit(repositoryPath, ['update-ref', 'refs/heads/candidate', input.commitOid]);
    await runGit(repositoryPath, ['update-ref', 'refs/taskboard/expected-old', input.expectedOldOid]);
    if (input.expectedBaseOid) {
      await runGit(repositoryPath, ['update-ref', 'refs/taskboard/expected-base', input.expectedBaseOid]);
    }
    await runGit(repositoryPath, ['repack', '-a', '-d'], {}, 30_000);
    await assertCommitGraph(repositoryPath, input.expectedOldOid, input.commitOid, input.expectedBaseOid);
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
 * Validates source objects only after first copying them into a server-owned store, then
 * publishes a validated pack with descriptor-bound, no-follow filesystem operations. Git
 * is never executed with a workspace or source object directory as its object store.
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
  if (process.platform !== 'linux') throw new WorkspaceCommitMaterializationError('materialization_failed', 'linux_required');

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'taskboard-candidate-objects-'));
  let stage = 'temporary_repository';
  let sourceObjectDirectory: BoundObjectDirectory | undefined;
  let targetObjectDirectory: BoundObjectDirectory | undefined;
  try {
    await chmod(temporaryRoot, 0o700);
    const trustedRepositoryPath = join(temporaryRoot, 'trusted.git');
    await runGit(temporaryRoot, ['init', '--bare', 'trusted.git']);
    await chmod(trustedRepositoryPath, 0o700);

    // Snapshot source objects with filesystem descriptors first. A source alternates file
    // is rejected during both pre-bind inspection and descriptor traversal, before Git runs.
    stage = 'source_snapshot';
    sourceObjectDirectory = await bindSourceObjectDirectory(input.sourceRepositoryPath);
    await copyBoundObjectStore(sourceObjectDirectory.handle, join(trustedRepositoryPath, 'objects'));
    await sourceObjectDirectory.handle.close();
    sourceObjectDirectory = undefined;
    await assertSafeObjectStore(join(trustedRepositoryPath, 'objects'));

    stage = 'trusted_connectivity';
    await assertCandidateObjects(trustedRepositoryPath, input.baseOid, input.headOid, input.treeOid);
    await input.onTrustedCandidateMaterialized?.(trustedRepositoryPath);

    // Generate and index a candidate-only pack in the trusted store. index-pack and every
    // following Git invocation operate exclusively inside temporaryRoot.
    stage = 'trusted_pack';
    const trustedPackPath = join(temporaryRoot, 'trusted-candidate.pack');
    await runGitWithInputToFile(
      trustedRepositoryPath,
      ['pack-objects', '--stdout', '--revs'],
      `${input.headOid}\n${input.baseOid}\n`,
      trustedPackPath,
      {},
      120_000,
    );
    const packHash = await indexPack(trustedRepositoryPath, trustedPackPath);
    const trustedPackDirectory = join(trustedRepositoryPath, 'objects', 'pack');
    const packName = `pack-${packHash}.pack`;
    const indexName = `pack-${packHash}.idx`;

    // Publication is deliberately not index-pack-with-GIT_OBJECT_DIRECTORY: that would let
    // Git traverse mutable objects/pack or objects/info. Only no-follow descriptor copying is
    // permitted. A substituted path is detected afterwards and fails closed.
    stage = 'target_binding';
    targetObjectDirectory = await bindWorkspaceObjectDirectory(input.workspaceRoot, input.repositoryName);
    await input.onWorkspaceObjectDirectoryBound?.(targetObjectDirectory.path);
    stage = 'target_publish';
    await publishTrustedPack(
      targetObjectDirectory.handle,
      join(trustedPackDirectory, packName),
      join(trustedPackDirectory, indexName),
    );
    stage = 'final_binding';
    await assertWorkspaceObjectDirectoryBinding(input.workspaceRoot, input.repositoryName, targetObjectDirectory);
    await targetObjectDirectory.handle.close();
    targetObjectDirectory = undefined;

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
    await sourceObjectDirectory?.handle.close();
    await targetObjectDirectory?.handle.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface BoundObjectDirectory {
  path: string;
  device: number;
  inode: number;
  handle: Awaited<ReturnType<typeof open>>;
}

async function bindWorkspaceObjectDirectory(workspaceRoot: string, repositoryName: string): Promise<BoundObjectDirectory> {
  return bindObjectDirectory(await resolveWorkspaceObjectDirectory(workspaceRoot, repositoryName));
}

async function bindSourceObjectDirectory(sourceRepositoryPath: string): Promise<BoundObjectDirectory> {
  try {
    if (!isAbsolute(sourceRepositoryPath)) throw new Error('source repository path must be absolute');
    const sourceInfo = await lstat(sourceRepositoryPath);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('unsafe source repository');
    const sourceRoot = await realpath(sourceRepositoryPath);
    const objectDirectory = await resolveRepositoryObjectDirectory(sourceRoot, sourceRoot);
    if (!objectDirectory) throw new Error('source git directory unavailable');
    return bindObjectDirectory(objectDirectory);
  } catch (error) {
    if (error instanceof WorkspaceCommitMaterializationError) throw error;
    throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
  }
}

/** Binds a validated directory so later copying never follows its mutable pathname. */
async function bindObjectDirectory(path: string): Promise<BoundObjectDirectory> {
  if (process.platform !== 'linux') throw new Error('descriptor-bound object directories require Linux');
  const expected = await lstat(path);
  if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error('unsafe object directory');
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
  expected: BoundObjectDirectory,
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

/**
 * Recursively copies an object store using only directory descriptors rooted at source.
 * Every component is reopened with O_NOFOLLOW, so replacing objects/pack or objects/info
 * after the top-level bind cannot redirect a read outside the bound tree.
 */
async function copyBoundObjectStore(source: Awaited<ReturnType<typeof open>>, destination: string): Promise<void> {
  let entries = 0;
  await copyBoundDirectory(`/proc/self/fd/${source.fd}`, destination, '', () => {
    entries += 1;
    if (entries > MAX_OBJECT_ENTRIES) throw new WorkspaceCommitMaterializationError('object_store_too_large');
  });
}

async function copyBoundDirectory(
  sourcePath: string,
  destination: string,
  relativePath: string,
  countEntry: () => void,
): Promise<void> {
  // /proc/self/fd/N itself is a kernel-managed symlink; O_NOFOLLOW must apply only
  // to an object-store child, not to that descriptor alias.
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_DIRECTORY
      | (/^\/proc\/self\/fd\/\d+$/.test(sourcePath) ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const info = await source.stat();
    if (!info.isDirectory()) throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const directory = await opendir(`/proc/self/fd/${source.fd}`);
    for await (const entry of directory) {
      countEntry();
      if (entry.name === '.' || entry.name === '..') throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (childRelativePath === 'info/alternates') {
        throw new WorkspaceCommitMaterializationError('alternates_forbidden');
      }
      const childSourcePath = `/proc/self/fd/${source.fd}/${entry.name}`;
      const childDestinationPath = join(destination, entry.name);
      if (entry.isDirectory()) {
        await copyBoundDirectory(childSourcePath, childDestinationPath, childRelativePath, countEntry);
      } else if (entry.isFile()) {
        await copyBoundRegularFile(childSourcePath, childDestinationPath, true);
      } else {
        throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
      }
    }
  } finally {
    await source.close();
  }
}

async function copyBoundRegularFile(sourcePath: string, destinationPath: string, exclusive: boolean): Promise<boolean> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!(await source.stat()).isFile()) throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
    try {
      destination = await open(destinationPath, exclusive ? 'wx' : 'w', 0o600);
    } catch (error) {
      if (exclusive && isAlreadyExists(error)) {
        const existing = await lstat(destinationPath);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
        return false;
      }
      throw error;
    }
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await destination.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
    return true;
  } finally {
    await destination?.close();
    await source.close();
  }
}

async function publishTrustedPack(
  targetObjectDirectory: Awaited<ReturnType<typeof open>>,
  packPath: string,
  indexPath: string,
): Promise<void> {
  const packDirectory = await open(
    `/proc/self/fd/${targetObjectDirectory.fd}/pack`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await packDirectory.stat()).isDirectory()) throw new WorkspaceCommitMaterializationError('unsafe_git_metadata');
    await copyBoundRegularFile(packPath, `/proc/self/fd/${packDirectory.fd}/${basename(packPath)}`, true);
    await copyBoundRegularFile(indexPath, `/proc/self/fd/${packDirectory.fd}/${basename(indexPath)}`, true);
  } finally {
    await packDirectory.close();
  }
}

async function assertCommitGraph(
  repositoryPath: string,
  expectedOldOid: string,
  commitOid: string,
  expectedBaseOid: string | undefined,
): Promise<void> {
  try {
    const oldType = (await runGit(repositoryPath, ['cat-file', '-t', expectedOldOid])).trim();
    const newType = (await runGit(repositoryPath, ['cat-file', '-t', commitOid])).trim();
    const baseType = expectedBaseOid ? (await runGit(repositoryPath, ['cat-file', '-t', expectedBaseOid])).trim() : 'commit';
    if (oldType !== 'commit' || newType !== 'commit' || baseType !== 'commit') throw new Error('not commit');
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
  let fields: string[];
  try {
    fields = (await runGit(repositoryPath, ['rev-list', '--parents', '-n', '1', commitOid])).trim().split(/\s+/);
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
    const mergeBase = (await runGit(repositoryPath, ['merge-base', expectedBaseOid, expectedOldOid])).trim();
    if (!OID.test(mergeBase) || mergeBase === expectedBaseOid) throw new WorkspaceCommitMaterializationError('parent_mismatch');
  } catch (error) {
    if (error instanceof WorkspaceCommitMaterializationError) throw error;
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
}

async function assertCandidateObjects(cwd: string, baseOid: string, headOid: string, treeOid: string): Promise<void> {
  try {
    if ((await runGit(cwd, ['cat-file', '-t', baseOid])).trim() !== 'commit') throw new Error('base');
    if ((await runGit(cwd, ['cat-file', '-t', headOid])).trim() !== 'commit') throw new Error('head');
    const actualTree = (await runGit(cwd, ['rev-parse', `${headOid}^{tree}`])).trim();
    if (actualTree !== treeOid) throw new Error('tree');
    await runGit(cwd, ['fsck', '--connectivity-only', '--no-dangling', headOid, baseOid], {}, 30_000);
  } catch {
    throw new WorkspaceCommitMaterializationError('object_missing');
  }
}

async function indexPack(repositoryPath: string, packPath: string): Promise<string> {
  const output = await runGitWithFileInput(repositoryPath, ['index-pack', '--stdin'], packPath, {}, 120_000);
  const match = /^(?:pack\t)?([0-9a-f]{40}|[0-9a-f]{64})$/.exec(output);
  if (!match) throw new Error('invalid pack hash');
  return match[1]!;
}

async function runGitWithInputToFile(
  cwd: string, args: string[], input: string, outputPath: string,
  extraEnv: Record<string, string> = {}, timeout = 30_000,
): Promise<void> {
  const output = await open(outputPath, 'wx', 0o600);
  const child = spawn('git', args, { cwd, stdio: ['pipe', output.fd, 'pipe'], env: safeGitEnvironment(cwd, extraEnv) });
  let stderr = '';
  let timedOut = false;
  child.stdin!.on('error', () => undefined);
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderr.length < MAX_GIT_OUTPUT) stderr += chunk.slice(0, MAX_GIT_OUTPUT - stderr.length);
  });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  try {
    child.stdin!.end(input);
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveExit(code ?? -1));
    });
    if (exitCode !== 0) throw new Error(`controlled git command failed: ${timedOut ? `timed out after ${timeout}ms` : stderr.trim()}`);
  } finally {
    clearTimeout(timer);
    await output.close();
  }
}

async function runGitWithFileInput(
  cwd: string, args: string[], inputPath: string,
  extraEnv: Record<string, string> = {}, timeout = 30_000,
): Promise<string> {
  return runSpawnedGit(cwd, args, extraEnv, timeout, (child) => createReadStream(inputPath).pipe(child.stdin!));
}

async function runSpawnedGit(
  cwd: string, args: string[], extraEnv: Record<string, string>, timeout: number,
  provideInput: (child: ReturnType<typeof spawn>) => void,
): Promise<string> {
  const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: safeGitEnvironment(cwd, extraEnv) });
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

async function runGit(cwd: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 15_000): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd, timeout, maxBuffer: MAX_GIT_OUTPUT, env: safeGitEnvironment(cwd, extraEnv),
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

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
