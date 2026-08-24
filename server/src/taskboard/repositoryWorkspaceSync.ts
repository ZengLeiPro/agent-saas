import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import { redactDurableSecrets } from './durableSecretRedaction.js';

export interface RepositoryWorkspaceGitCommand {
  cwd: string;
  args: readonly string[];
  /** Optional trusted process environment overrides (used for deterministic server-authored commits). */
  env?: Readonly<Record<string, string>>;
}

export interface RepositoryWorkspaceGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RepositoryWorkspaceSyncLock {
  /** Canonical repository common-dir realpath. The lock is repository-wide. */
  repositoryPath: string;
  /** Retained for host compatibility; always '*' and never partitions the lock. */
  branch: string;
}

/**
 * Local infrastructure boundary. The caller owns a cross-process lock implementation;
 * this service never asks an Agent to run Git and never builds a shell command string.
 */
export interface RepositoryWorkspaceSyncHost {
  withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T>;
  /** Resolve repository aliases/worktrees to one canonical common-dir lock identity. */
  resolveRepositoryLockScope?(repositoryPath: string): Promise<string>;
  /** Must validate the real common-dir ownership/mode while the repository lock is held. */
  validateServerOwnedRepository(repositoryPath: string): Promise<void>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
  /** Testable filesystem canonicalization boundary; production defaults to fs.realpath. */
  realpath?(path: string): Promise<string>;
  /** Testable lstat boundary used to reject symlinks and pre-existing foreign paths before fetch. */
  lstat?(path: string): Promise<{ isSymbolicLink(): boolean }>;
  /** Testable ownership/mode boundary for the controlled worktree parent. */
  stat?(path: string): Promise<{ uid: number; mode: number; isDirectory(): boolean }>;
}

export interface RepositoryWorkspaceSyncInput {
  repositoryPath: string;
  worktreePath: string;
  baseBranch: string;
  integrationBranch: string;
  /** Canonical server-configured HTTPS URL; remote aliases/config are never used for network access. */
  controlledRemoteUrl: string;
  /** Short-lived server-owned askpass environment used only by the explicit fetch. */
  fetchEnvironment?: Readonly<Record<string, string>>;
  /** Deterministic compose may replace a clean local integration ref when the base advanced. */
  integrationWorktreeMode?: 'fast_forward' | 'reset_to_base';
  /** Frozen GitHub PR heads whose exact objects must be materialized before deterministic compose. */
  frozenPullRequestHeads?: readonly {
    providerPullRequestId: string;
    expectedHeadOid: string;
  }[];
}

export interface CandidateRevisionObjectSyncInput {
  repositoryPath: string;
  integrationBranch: string;
  baseBranch: string;
  controlledRemoteUrl: string;
  fetchEnvironment?: Readonly<Record<string, string>>;
  candidateId: string;
  candidateRevision: number;
  providerPullRequestId: string;
  expectedBaseOid: string;
  expectedHeadOid: string;
  expectedTreeOid: string;
}

export interface CandidateRevisionObjectSyncResult {
  repositoryPath: string;
  baseOid: string;
  headOid: string;
  treeOid: string;
}

export interface RepositoryWorkspaceSyncResult {
  repositoryPath: string;
  worktreePath: string;
  baseRef: string;
  integrationRef: string;
  baseOid: string;
  localBase: 'absent' | 'current' | 'fast_forwarded';
  integrationWorktree: 'created' | 'current' | 'fast_forwarded' | 'reset_to_base';
}

export type RepositoryWorkspaceSyncErrorCode =
  | 'INVALID_PATH'
  | 'INVALID_REF'
  | 'MIRROR_UNSAFE'
  | 'GIT_COMMAND_FAILED'
  | 'WORKTREE_UNKNOWN'
  | 'WORKTREE_DIRTY'
  | 'WORKTREE_DIVERGED';

export interface RepositoryWorkspaceEvidence {
  version: 1;
  repositoryPath: string;
  worktreePath: string;
  expectedBranch: string;
  repositoryRealpath?: string;
  worktreeRealpath?: string;
  headOid?: string;
  branch?: string;
  detached?: boolean;
  porcelainRecord?: string;
  statusPorcelain?: string;
  symbolicHead?: string;
  gitDir?: string;
  commonDir?: string;
}

export class RepositoryWorkspaceSyncError extends Error {
  constructor(
    message: string,
    readonly code: RepositoryWorkspaceSyncErrorCode,
    readonly command?: RepositoryWorkspaceGitCommand,
    readonly evidence?: RepositoryWorkspaceEvidence,
    /** Bounded during durable evidence attachment; used only for porcelain parse failures. */
    readonly rawPorcelainRecord?: string,
  ) {
    super(message);
    this.name = 'RepositoryWorkspaceSyncError';
  }
}

interface WorktreeRecord {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  porcelain: string;
}

const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' } as const;

export type RepositoryWorkspaceMutationGuard = () => Promise<void>;

export async function withRepositoryScopeLock<T>(
  host: RepositoryWorkspaceSyncHost,
  repositoryPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonical = host.resolveRepositoryLockScope
    ? await host.resolveRepositoryLockScope(repositoryPath)
    : await (host.realpath ?? realpath)(repositoryPath).catch(() => repositoryPath);
  return host.withRepositoryBranchLock({ repositoryPath: canonical, branch: '*' }, operation);
}

export async function syncRepositoryWorkspace(
  host: RepositoryWorkspaceSyncHost,
  rawInput: RepositoryWorkspaceSyncInput,
  beforeMutation?: RepositoryWorkspaceMutationGuard,
): Promise<RepositoryWorkspaceSyncResult> {
  const input = validateInput(rawInput);
  return withRepositoryScopeLock(host, input.repositoryPath, () => syncLocked(host, input, beforeMutation));
}

/** Caller already holds the exact repository+branch lock. Avoids nested advisory-lock deadlocks. */
export function syncRepositoryWorkspaceLocked(
  host: RepositoryWorkspaceSyncHost,
  rawInput: RepositoryWorkspaceSyncInput,
  beforeMutation?: RepositoryWorkspaceMutationGuard,
): Promise<RepositoryWorkspaceSyncResult> {
  return syncLocked(host, validateInput(rawInput), beforeMutation);
}

export async function syncCandidateRevisionObjects(
  host: RepositoryWorkspaceSyncHost,
  input: CandidateRevisionObjectSyncInput,
): Promise<CandidateRevisionObjectSyncResult> {
  validateCandidateObjectSyncInput(input);
  return withRepositoryScopeLock(
    host,
    input.repositoryPath,
    async () => {
      try {
        await host.validateServerOwnedRepository(input.repositoryPath);
      } catch (error) {
        throw new RepositoryWorkspaceSyncError(
          `Server-owned mirror validation failed: ${error instanceof Error ? error.message : String(error)}`,
          'MIRROR_UNSAFE',
        );
      }
      const remoteBaseRef = `refs/remotes/origin/${input.baseBranch}`;
      const candidateHeadRef = `refs/ky-integration-v3/candidates/${input.candidateId}/r${input.candidateRevision}/head`;
      const shallow = (await git(host, input.repositoryPath, ['rev-parse', '--is-shallow-repository'])).stdout.trim();
      if (shallow !== 'true' && shallow !== 'false') {
        throw new RepositoryWorkspaceSyncError('Git returned an invalid shallow repository state', 'WORKTREE_UNKNOWN');
      }
      await git(host, input.repositoryPath, [
        'fetch', '--no-tags', ...(shallow === 'true' ? ['--unshallow'] : []), '--', input.controlledRemoteUrl,
        `+refs/heads/${input.baseBranch}:${remoteBaseRef}`,
        `+refs/pull/${input.providerPullRequestId}/head:${candidateHeadRef}`,
      ], input.fetchEnvironment);
      const actualHead = singleOid(
        await git(host, input.repositoryPath, ['rev-parse', '--verify', candidateHeadRef]),
        candidateHeadRef,
      );
      if (actualHead !== input.expectedHeadOid) {
        throw new RepositoryWorkspaceSyncError(
          `Candidate pull request head drifted: expected ${input.expectedHeadOid}, received ${actualHead}`,
          'WORKTREE_DIVERGED',
        );
      }
      const actualBase = singleOid(
        await git(host, input.repositoryPath, ['rev-parse', '--verify', `${input.expectedBaseOid}^{commit}`]),
        input.expectedBaseOid,
      );
      const actualTree = singleOid(
        await git(host, input.repositoryPath, ['rev-parse', '--verify', `${input.expectedHeadOid}^{tree}`]),
        input.expectedTreeOid,
      );
      // The authoritative base may advance after a PR head is prepared; exact subject
      // identity does not require that newer base tip to be an ancestor of the PR head.
      if (actualBase !== input.expectedBaseOid || actualTree !== input.expectedTreeOid
        || !await isAncestor(host, input.repositoryPath, input.expectedBaseOid, remoteBaseRef)) {
        throw new RepositoryWorkspaceSyncError('Candidate revision object identity or ancestry mismatch', 'WORKTREE_DIVERGED');
      }
      return {
        repositoryPath: input.repositoryPath,
        baseOid: actualBase,
        headOid: actualHead,
        treeOid: actualTree,
      };
    },
  );
}

async function syncLocked(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  beforeMutation?: RepositoryWorkspaceMutationGuard,
): Promise<RepositoryWorkspaceSyncResult> {
  const integrationRef = `refs/heads/${input.integrationBranch}`;
  const baseEvidence: RepositoryWorkspaceEvidence = {
    version: 1,
    repositoryPath: input.repositoryPath,
    worktreePath: input.worktreePath,
    expectedBranch: integrationRef,
  };
  try {
    await host.validateServerOwnedRepository(input.repositoryPath);
  } catch (error) {
    throw new RepositoryWorkspaceSyncError(
      `Server-owned mirror validation failed: ${error instanceof Error ? error.message : String(error)}`,
      'MIRROR_UNSAFE', undefined, baseEvidence,
    );
  }

  // Ownership is a read-only admission gate and intentionally precedes fetch. A detached,
  // branchless, aliased, dirty, or foreign worktree must observe zero Git writes.
  let worktrees: WorktreeRecord[];
  let rawWorktreePorcelain = '';
  try {
    rawWorktreePorcelain = (await git(host, input.repositoryPath, [
      'worktree', 'list', '--porcelain',
    ], READ_ONLY_GIT_ENV)).stdout;
    worktrees = parseWorktrees(rawWorktreePorcelain);
    assertUniqueWorktreePathsAndBranches(worktrees);
  } catch (error) {
    throw attachEvidence(error, {
      ...baseEvidence,
      ...(rawWorktreePorcelain ? { porcelainRecord: bounded(rawWorktreePorcelain, 8_192) } : {}),
    });
  }
  await assertRequestedWorktreeOwnership(host, input, integrationRef, worktrees, baseEvidence);
  const baseRef = `refs/heads/${input.baseBranch}`;
  await assertBaseWorktreeOwnership(host, input, baseRef, worktrees, baseEvidence);

  const remoteBaseRef = `refs/remotes/origin/${input.baseBranch}`;
  const frozenHeads = input.frozenPullRequestHeads ?? [];
  await beforeMutation?.();
  // Explicit URL/refspec avoids local remote.*.url, uploadpack and helper config. Fetching the
  // frozen PR refs here is mandatory: an old reviewed source head need not be reachable from main.
  await git(host, input.repositoryPath, [
    'fetch', '--no-tags', '--prune', '--', input.controlledRemoteUrl,
    `+refs/heads/${input.baseBranch}:${remoteBaseRef}`,
    ...frozenHeads.map(({ providerPullRequestId }) => (
      `+refs/pull/${providerPullRequestId}/head:${frozenPullRequestHeadRef(providerPullRequestId)}`
    )),
  ], input.fetchEnvironment);
  for (const frozen of frozenHeads) {
    const actual = singleOid(
      await git(host, input.repositoryPath, ['rev-parse', '--verify', frozenPullRequestHeadRef(frozen.providerPullRequestId)]),
      `frozen pull request ${frozen.providerPullRequestId}`,
    );
    if (actual !== frozen.expectedHeadOid) {
      throw new RepositoryWorkspaceSyncError(
        `Frozen pull request ${frozen.providerPullRequestId} head drifted: expected ${frozen.expectedHeadOid}, received ${actual}`,
        'WORKTREE_DIVERGED', undefined, baseEvidence,
      );
    }
  }

  const baseOid = singleOid(await git(host, input.repositoryPath, ['rev-parse', '--verify', remoteBaseRef]), remoteBaseRef);
  const localBase = await refreshLocalBase(host, input.repositoryPath, baseRef, remoteBaseRef, worktrees, beforeMutation);
  const integrationWorktree = await prepareIntegrationWorktree(
    host,
    input,
    integrationRef,
    remoteBaseRef,
    worktrees,
    beforeMutation,
  );

  return {
    repositoryPath: input.repositoryPath,
    worktreePath: input.worktreePath,
    baseRef,
    integrationRef,
    baseOid,
    localBase,
    integrationWorktree,
  };
}

async function assertRequestedWorktreeOwnership(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  integrationRef: string,
  worktrees: WorktreeRecord[],
  base: RepositoryWorkspaceEvidence,
): Promise<void> {
  const atRequestedPath = worktrees.find((entry) => entry.path === input.worktreePath);
  const forBranch = worktrees.find((entry) => entry.branch === integrationRef);
  if (!atRequestedPath) {
    if (forBranch) {
      throw new RepositoryWorkspaceSyncError(
        `Integration branch is already attached to a different worktree: ${forBranch.path}`,
        'WORKTREE_UNKNOWN', undefined, evidenceForRecord(base, forBranch),
      );
    }
    await assertRequestedPathAbsent(host, input.worktreePath, base);
    return;
  }

  await assertOwnedWorktreeRecord(host, input, atRequestedPath, integrationRef, base, true);
}

async function assertBaseWorktreeOwnership(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  baseRef: string,
  worktrees: WorktreeRecord[],
  base: RepositoryWorkspaceEvidence,
): Promise<void> {
  const atRepositoryPath = worktrees.find((entry) => entry.path === input.repositoryPath);
  const forBranch = worktrees.find((entry) => entry.branch === baseRef);
  if (atRepositoryPath && atRepositoryPath.branch !== baseRef) {
    const evidence = await collectWorktreeEvidence(host, input, atRepositoryPath, {
      ...base, worktreePath: atRepositoryPath.path, expectedBranch: baseRef,
    });
    throw new RepositoryWorkspaceSyncError(
      'Repository root worktree does not own the configured base branch',
      evidence.statusPorcelain ? 'WORKTREE_DIRTY' : 'WORKTREE_UNKNOWN', undefined, evidence,
    );
  }
  if (!forBranch) return;
  await assertOwnedWorktreeRecord(host, input, forBranch, baseRef, {
    ...base, worktreePath: forBranch.path, expectedBranch: baseRef,
  }, forBranch.path !== input.repositoryPath);
}

async function assertOwnedWorktreeRecord(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  record: WorktreeRecord,
  expectedRef: string,
  base: RepositoryWorkspaceEvidence,
  linked: boolean,
): Promise<RepositoryWorkspaceEvidence> {
  const pathInfo = await (host.lstat ? host.lstat(record.path) : lstat(record.path)).catch(() => undefined);
  if (!pathInfo || pathInfo.isSymbolicLink()) {
    throw new RepositoryWorkspaceSyncError(
      'Worktree path is missing, aliased, or symbolic despite Git ownership',
      'WORKTREE_UNKNOWN', undefined, evidenceForRecord(base, record),
    );
  }
  const evidence = await collectWorktreeEvidence(host, input, record, base);
  const gitDirChild = evidence.commonDir && evidence.gitDir ? relative(evidence.commonDir, evidence.gitDir) : '';
  const invalidGitDir = linked
    ? !gitDirChild || gitDirChild === '..' || gitDirChild.startsWith(`..${sep}`) || !gitDirChild.startsWith(`worktrees${sep}`)
    : gitDirChild !== '';
  if (record.detached || record.branch !== expectedRef
    || evidence.symbolicHead !== expectedRef
    || evidence.headOid !== record.head
    || evidence.repositoryRealpath !== input.repositoryPath
    || evidence.worktreeRealpath !== record.path
    || !evidence.gitDir || !evidence.commonDir || invalidGitDir
    || Boolean(evidence.statusPorcelain)) {
    const state = record.detached ? 'detached' : record.branch ?? 'branchless';
    throw new RepositoryWorkspaceSyncError(
      `Worktree ownership validation failed (${state})`,
      evidence.statusPorcelain ? 'WORKTREE_DIRTY' : 'WORKTREE_UNKNOWN', undefined, evidence,
    );
  }
  return evidence;
}

async function assertRequestedPathAbsent(
  host: RepositoryWorkspaceSyncHost,
  worktreePath: string,
  evidence: RepositoryWorkspaceEvidence,
): Promise<void> {
  try {
    await (host.lstat ? host.lstat(worktreePath) : lstat(worktreePath));
    throw new RepositoryWorkspaceSyncError(
      'Requested worktree path already exists without exact Git worktree ownership',
      'WORKTREE_UNKNOWN', undefined, evidence,
    );
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
      if (error instanceof RepositoryWorkspaceSyncError) throw error;
      throw new RepositoryWorkspaceSyncError('Requested worktree path cannot be admitted safely', 'WORKTREE_UNKNOWN', undefined, evidence);
    }
  }
  const parent = dirname(worktreePath);
  try {
    const parentLink = await (host.lstat ? host.lstat(parent) : lstat(parent));
    const canonicalParent = await (host.realpath ?? realpath)(parent);
    const parentInfo = await (host.stat ? host.stat(parent) : stat(parent));
    const ownerMismatch = typeof process.getuid === 'function' && parentInfo.uid !== process.getuid();
    if (parentLink.isSymbolicLink() || canonicalParent !== parent || !parentInfo.isDirectory()
      || ownerMismatch || (parentInfo.mode & 0o022) !== 0) {
      throw new Error('controlled worktree parent is aliased or unsafe');
    }
  } catch (error) {
    throw new RepositoryWorkspaceSyncError(
      `Requested worktree parent cannot be admitted safely: ${error instanceof Error ? error.message : String(error)}`,
      'WORKTREE_UNKNOWN', undefined, evidence,
    );
  }
}

async function collectWorktreeEvidence(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  record: WorktreeRecord,
  base: RepositoryWorkspaceEvidence,
): Promise<RepositoryWorkspaceEvidence> {
  const canonical = host.realpath ?? ((path: string) => realpath(path));
  const evidence = evidenceForRecord(base, record);
  try { evidence.repositoryRealpath = await canonical(input.repositoryPath); } catch { /* retained as missing */ }
  try { evidence.worktreeRealpath = await canonical(record.path); } catch { /* retained as missing */ }
  const head = await runGit(host, { cwd: record.path, args: ['rev-parse', '--verify', 'HEAD'], env: READ_ONLY_GIT_ENV });
  if (head.exitCode === 0) evidence.headOid = bounded(head.stdout.trim(), 128);
  const symbolic = await runGit(host, { cwd: record.path, args: ['symbolic-ref', '-q', 'HEAD'], env: READ_ONLY_GIT_ENV });
  if (symbolic.exitCode === 0) evidence.symbolicHead = bounded(symbolic.stdout.trim(), 300);
  const status = await runGit(host, { cwd: record.path, args: ['status', '--porcelain=v1', '--untracked-files=all'], env: READ_ONLY_GIT_ENV });
  if (status.exitCode === 0) evidence.statusPorcelain = bounded(status.stdout, 8_192);
  const gitDir = await runGit(host, { cwd: record.path, args: ['rev-parse', '--git-dir'], env: READ_ONLY_GIT_ENV });
  const commonDir = await runGit(host, { cwd: record.path, args: ['rev-parse', '--git-common-dir'], env: READ_ONLY_GIT_ENV });
  if (gitDir.exitCode === 0) {
    try { evidence.gitDir = await canonical(resolve(record.path, gitDir.stdout.trim())); } catch { /* retained as missing */ }
  }
  if (commonDir.exitCode === 0) {
    try { evidence.commonDir = await canonical(resolve(record.path, commonDir.stdout.trim())); } catch { /* retained as missing */ }
  }
  return evidence;
}

function evidenceForRecord(base: RepositoryWorkspaceEvidence, record: WorktreeRecord): RepositoryWorkspaceEvidence {
  return {
    ...base,
    headOid: record.head,
    ...(record.branch ? { branch: record.branch } : {}),
    detached: record.detached,
    porcelainRecord: bounded(record.porcelain, 8_192),
  };
}

function attachEvidence(error: unknown, evidence: RepositoryWorkspaceEvidence): RepositoryWorkspaceSyncError {
  if (error instanceof RepositoryWorkspaceSyncError) {
    const durableEvidence = {
      ...evidence,
      ...(error.rawPorcelainRecord ? { porcelainRecord: bounded(error.rawPorcelainRecord, 8_192) } : {}),
      ...error.evidence,
    };
    return new RepositoryWorkspaceSyncError(error.message, error.code, error.command, durableEvidence);
  }
  return new RepositoryWorkspaceSyncError(
    error instanceof Error ? error.message : String(error), 'WORKTREE_UNKNOWN', undefined, evidence,
  );
}

function bounded(value: string, maximum: number): string {
  return redactDurableSecrets(value.replace(/\0/g, '')).slice(0, maximum);
}

async function refreshLocalBase(
  host: RepositoryWorkspaceSyncHost,
  repositoryPath: string,
  baseRef: string,
  remoteBaseRef: string,
  worktrees: WorktreeRecord[],
  beforeMutation?: RepositoryWorkspaceMutationGuard,
): Promise<RepositoryWorkspaceSyncResult['localBase']> {
  const baseWorktree = worktrees.find((entry) => entry.branch === baseRef);
  if (!baseWorktree) return 'absent';
  await assertClean(host, baseWorktree);

  if (await isAncestor(host, repositoryPath, baseRef, remoteBaseRef)) {
    if (await isAncestor(host, repositoryPath, remoteBaseRef, baseRef)) return 'current';
    await beforeMutation?.();
    await git(host, baseWorktree.path, ['merge', '--ff-only', remoteBaseRef]);
    return 'fast_forwarded';
  }
  throw new RepositoryWorkspaceSyncError(
    `Local ${baseRef} has commits not present in ${remoteBaseRef}`,
    'WORKTREE_DIVERGED',
  );
}

async function prepareIntegrationWorktree(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  integrationRef: string,
  remoteBaseRef: string,
  worktrees: WorktreeRecord[],
  beforeMutation?: RepositoryWorkspaceMutationGuard,
): Promise<RepositoryWorkspaceSyncResult['integrationWorktree']> {
  const atRequestedPath = worktrees.find((entry) => entry.path === input.worktreePath);
  const forBranch = worktrees.find((entry) => entry.branch === integrationRef);

  if (atRequestedPath && atRequestedPath.branch !== integrationRef) {
    throw new RepositoryWorkspaceSyncError(
      `Requested worktree path is attached to ${atRequestedPath.branch ?? 'an unknown HEAD'}`,
      'WORKTREE_UNKNOWN',
    );
  }
  if (forBranch && forBranch.path !== input.worktreePath) {
    throw new RepositoryWorkspaceSyncError(
      `Integration branch is already attached to a different worktree: ${forBranch.path}`,
      'WORKTREE_UNKNOWN',
    );
  }

  if (atRequestedPath) {
    await assertClean(host, atRequestedPath);
    if (input.integrationWorktreeMode === 'reset_to_base') {
      await beforeMutation?.();
      await git(host, atRequestedPath.path, ['reset', '--hard', remoteBaseRef]);
      return 'reset_to_base';
    }
    return fastForwardWorktree(host, input.repositoryPath, atRequestedPath.path, integrationRef, remoteBaseRef, beforeMutation);
  }

  const branchExists = await refExists(host, input.repositoryPath, integrationRef);
  if (branchExists) {
    if (input.integrationWorktreeMode !== 'reset_to_base') {
      await assertFastForwardable(host, input.repositoryPath, integrationRef, remoteBaseRef);
    }
    await beforeMutation?.();
    await git(host, input.repositoryPath, ['worktree', 'add', '--', input.worktreePath, integrationRef]);
    await assertCreatedWorktreeOwnership(host, input, integrationRef);
    if (input.integrationWorktreeMode === 'reset_to_base') {
      await beforeMutation?.();
      await git(host, input.worktreePath, ['reset', '--hard', remoteBaseRef]);
      return 'reset_to_base';
    }
    if (await isAncestor(host, input.repositoryPath, remoteBaseRef, integrationRef)) return 'created';
    await beforeMutation?.();
    await git(host, input.worktreePath, ['merge', '--ff-only', remoteBaseRef]);
    return 'fast_forwarded';
  }

  await beforeMutation?.();
  await git(host, input.repositoryPath, [
    'worktree', 'add', '-b', input.integrationBranch, '--no-track', '--', input.worktreePath, remoteBaseRef,
  ]);
  await assertCreatedWorktreeOwnership(host, input, integrationRef);
  return 'created';
}

async function assertCreatedWorktreeOwnership(
  host: RepositoryWorkspaceSyncHost,
  input: RepositoryWorkspaceSyncInput,
  integrationRef: string,
): Promise<void> {
  let raw = '';
  try {
    raw = (await git(host, input.repositoryPath, ['worktree', 'list', '--porcelain'], READ_ONLY_GIT_ENV)).stdout;
    const records = parseWorktrees(raw);
    assertUniqueWorktreePathsAndBranches(records);
    const created = records.find((record) => record.path === input.worktreePath);
    if (!created || created.branch !== integrationRef
      || records.some((record) => record.branch === integrationRef && record.path !== input.worktreePath)) {
      throw new RepositoryWorkspaceSyncError(
        'Created worktree is not attached to the exact requested path and branch',
        'WORKTREE_UNKNOWN', undefined, {
          version: 1,
          repositoryPath: input.repositoryPath,
          worktreePath: input.worktreePath,
          expectedBranch: integrationRef,
          porcelainRecord: bounded(raw, 8_192),
        },
      );
    }
    await assertOwnedWorktreeRecord(host, input, created, integrationRef, {
      version: 1,
      repositoryPath: input.repositoryPath,
      worktreePath: input.worktreePath,
      expectedBranch: integrationRef,
      porcelainRecord: bounded(raw, 8_192),
    }, true);
  } catch (error) {
    throw attachEvidence(error, {
      version: 1,
      repositoryPath: input.repositoryPath,
      worktreePath: input.worktreePath,
      expectedBranch: integrationRef,
      ...(raw ? { porcelainRecord: bounded(raw, 8_192) } : {}),
    });
  }
}

async function fastForwardWorktree(
  host: RepositoryWorkspaceSyncHost,
  repositoryPath: string,
  worktreePath: string,
  integrationRef: string,
  remoteBaseRef: string,
  beforeMutation?: RepositoryWorkspaceMutationGuard,
): Promise<'current' | 'fast_forwarded'> {
  await assertFastForwardable(host, repositoryPath, integrationRef, remoteBaseRef);
  if (await isAncestor(host, repositoryPath, remoteBaseRef, integrationRef)) return 'current';
  await beforeMutation?.();
  await git(host, worktreePath, ['merge', '--ff-only', remoteBaseRef]);
  return 'fast_forwarded';
}

async function assertFastForwardable(
  host: RepositoryWorkspaceSyncHost,
  repositoryPath: string,
  integrationRef: string,
  remoteBaseRef: string,
): Promise<void> {
  if (!await isAncestor(host, repositoryPath, integrationRef, remoteBaseRef)) {
    throw new RepositoryWorkspaceSyncError(
      `${integrationRef} contains local commits or has diverged from ${remoteBaseRef}`,
      'WORKTREE_DIVERGED',
    );
  }
}

async function assertClean(host: RepositoryWorkspaceSyncHost, worktree: WorktreeRecord): Promise<void> {
  if (!worktree.branch || worktree.detached) {
    throw new RepositoryWorkspaceSyncError(`Worktree has an unknown branch state: ${worktree.path}`, 'WORKTREE_UNKNOWN');
  }
  const status = await git(host, worktree.path, ['status', '--porcelain=v1', '--untracked-files=all'], READ_ONLY_GIT_ENV);
  if (status.stdout.length > 0) {
    throw new RepositoryWorkspaceSyncError(`Worktree is dirty: ${worktree.path}`, 'WORKTREE_DIRTY');
  }
}

async function refExists(host: RepositoryWorkspaceSyncHost, cwd: string, ref: string): Promise<boolean> {
  const result = await runGit(host, { cwd, args: ['show-ref', '--verify', '--quiet', ref] });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw commandFailure({ cwd, args: ['show-ref', '--verify', '--quiet', ref] }, result);
}

async function isAncestor(
  host: RepositoryWorkspaceSyncHost,
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const command = { cwd, args: ['merge-base', '--is-ancestor', ancestor, descendant] } as const;
  const result = await runGit(host, command);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw commandFailure(command, result);
}

async function git(
  host: RepositoryWorkspaceSyncHost,
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<RepositoryWorkspaceGitResult> {
  const command = { cwd, args, ...(env ? { env } : {}) };
  const result = await runGit(host, command);
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return result;
}

async function runGit(
  host: RepositoryWorkspaceSyncHost,
  command: RepositoryWorkspaceGitCommand,
): Promise<RepositoryWorkspaceGitResult> {
  try {
    return await host.runGit(command);
  } catch (error) {
    throw new RepositoryWorkspaceSyncError(
      `Git command could not be executed: ${redactDurableSecrets(error instanceof Error ? error.message : String(error))}`,
      'GIT_COMMAND_FAILED',
      diagnosticCommand(command),
    );
  }
}

function commandFailure(
  command: RepositoryWorkspaceGitCommand,
  result: RepositoryWorkspaceGitResult,
): RepositoryWorkspaceSyncError {
  const detail = redactDurableSecrets(result.stderr.trim()) || `exit code ${result.exitCode}`;
  const operation = /^[a-z][a-z-]*$/.test(command.args[0] ?? '') ? command.args[0] : 'command';
  return new RepositoryWorkspaceSyncError(
    `Git ${operation} failed: ${detail}`,
    'GIT_COMMAND_FAILED',
    diagnosticCommand(command),
  );
}

function diagnosticCommand(command: RepositoryWorkspaceGitCommand): RepositoryWorkspaceGitCommand {
  return { cwd: command.cwd, args: command.args };
}

function parseWorktrees(output: string): WorktreeRecord[] {
  if (!output.trim()) {
    throw new RepositoryWorkspaceSyncError('Git returned no worktree records', 'WORKTREE_UNKNOWN');
  }
  return output.trimEnd().split(/\n\n+/).map((block) => {
    const fields = block.split('\n');
    const pathLine = fields.find((line) => line.startsWith('worktree '));
    const headLine = fields.find((line) => line.startsWith('HEAD '));
    const branchLine = fields.find((line) => line.startsWith('branch '));
    const detached = fields.includes('detached');
    if (!pathLine || !headLine || Boolean(branchLine) === detached) {
      throw new RepositoryWorkspaceSyncError(
        `Malformed worktree record: ${bounded(block, 8_192)}`, 'WORKTREE_UNKNOWN', undefined, undefined, block,
      );
    }
    const path = pathLine.slice('worktree '.length);
    const head = headLine.slice('HEAD '.length);
    if (!isSafeAbsolutePath(path) || !OID_PATTERN.test(head)) {
      throw new RepositoryWorkspaceSyncError(
        `Unsafe worktree record: ${bounded(block, 8_192)}`, 'WORKTREE_UNKNOWN', undefined, undefined, block,
      );
    }
    const branch = branchLine?.slice('branch '.length);
    if (branch && !branch.startsWith('refs/heads/')) {
      throw new RepositoryWorkspaceSyncError(
        `Unknown worktree branch: ${bounded(branch, 8_192)}`, 'WORKTREE_UNKNOWN', undefined, undefined, block,
      );
    }
    return { path, head, branch, detached, porcelain: block };
  });
}

function assertUniqueWorktreePathsAndBranches(worktrees: WorktreeRecord[]): void {
  const paths = new Set<string>();
  const branches = new Set<string>();
  for (const worktree of worktrees) {
    if (paths.has(worktree.path) || (worktree.branch && branches.has(worktree.branch))) {
      throw new RepositoryWorkspaceSyncError('Git returned ambiguous worktree ownership', 'WORKTREE_UNKNOWN');
    }
    paths.add(worktree.path);
    if (worktree.branch) branches.add(worktree.branch);
  }
}

function singleOid(result: RepositoryWorkspaceGitResult, ref: string): string {
  const oid = result.stdout.trim();
  if (!OID_PATTERN.test(oid)) {
    throw new RepositoryWorkspaceSyncError(`Git returned an invalid oid for ${ref}`, 'WORKTREE_UNKNOWN');
  }
  return oid;
}

function validateCandidateObjectSyncInput(input: CandidateRevisionObjectSyncInput): void {
  if (!isSafeAbsolutePath(input.repositoryPath) || input.repositoryPath === '/') {
    throw new RepositoryWorkspaceSyncError('repositoryPath must be a normalized absolute path', 'INVALID_PATH');
  }
  assertBranch(input.baseBranch, 'baseBranch');
  assertBranch(input.integrationBranch, 'integrationBranch');
  assertControlledRemoteUrl(input.controlledRemoteUrl);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(input.candidateId)
    || !Number.isInteger(input.candidateRevision) || input.candidateRevision < 1
    || !/^[1-9]\d*$/.test(input.providerPullRequestId)
    || ![input.expectedBaseOid, input.expectedHeadOid, input.expectedTreeOid].every((oid) => OID_PATTERN.test(oid))) {
    throw new RepositoryWorkspaceSyncError('Candidate revision object binding is invalid', 'INVALID_REF');
  }
}

function validateInput(input: RepositoryWorkspaceSyncInput): RepositoryWorkspaceSyncInput {
  if (!isSafeAbsolutePath(input.repositoryPath) || input.repositoryPath === '/') {
    throw new RepositoryWorkspaceSyncError('repositoryPath must be a normalized absolute path', 'INVALID_PATH');
  }
  if (!isSafeAbsolutePath(input.worktreePath) || input.worktreePath === '/') {
    throw new RepositoryWorkspaceSyncError('worktreePath must be a normalized absolute path', 'INVALID_PATH');
  }
  if (input.repositoryPath === input.worktreePath) {
    throw new RepositoryWorkspaceSyncError('Repository and integration worktree paths must differ', 'INVALID_PATH');
  }
  assertBranch(input.baseBranch, 'baseBranch');
  assertBranch(input.integrationBranch, 'integrationBranch');
  assertControlledRemoteUrl(input.controlledRemoteUrl);
  const frozenByPullRequest = new Map<string, string>();
  for (const frozen of input.frozenPullRequestHeads ?? []) {
    if (!/^[1-9]\d*$/.test(frozen.providerPullRequestId) || !OID_PATTERN.test(frozen.expectedHeadOid)) {
      throw new RepositoryWorkspaceSyncError('Frozen pull request head is invalid', 'INVALID_REF');
    }
    const previous = frozenByPullRequest.get(frozen.providerPullRequestId);
    if (previous && previous !== frozen.expectedHeadOid) {
      throw new RepositoryWorkspaceSyncError('Frozen pull request has conflicting expected heads', 'INVALID_REF');
    }
    frozenByPullRequest.set(frozen.providerPullRequestId, frozen.expectedHeadOid);
  }
  if (input.baseBranch === input.integrationBranch) {
    throw new RepositoryWorkspaceSyncError('Base and integration branches must differ', 'INVALID_REF');
  }
  return { ...input };
}

function frozenPullRequestHeadRef(providerPullRequestId: string): string {
  return `refs/ky-integration-v3/source-heads/pr-${providerPullRequestId}`;
}

function assertControlledRemoteUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(parsed.pathname)) throw new Error('forbidden');
  } catch {
    throw new RepositoryWorkspaceSyncError('controlledRemoteUrl must be a canonical GitHub HTTPS URL', 'INVALID_PATH');
  }
}

function isSafeAbsolutePath(path: string): boolean {
  return path.length > 1
    && isAbsolute(path)
    && normalize(path) === path
    && resolve(path) === path
    && !/[\0\r\n]/.test(path);
}

function assertBranch(branch: string, field: string): void {
  const invalid = branch.length === 0
    || branch.length > 240
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.includes('..')
    || branch === '@'
    || branch.includes('@{')
    || /[\0-\x20\x7f~^:?*\[\\]/.test(branch)
    || branch.split('/').some((part) => (
      part.length === 0
      || part.startsWith('.')
      || part.endsWith('.')
      || part.endsWith('.lock')
    ));
  if (invalid) throw new RepositoryWorkspaceSyncError(`${field} is not a safe branch name`, 'INVALID_REF');
}
