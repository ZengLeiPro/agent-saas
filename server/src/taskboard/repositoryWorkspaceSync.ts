import { isAbsolute, normalize, resolve } from 'node:path';

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
  repositoryPath: string;
  branch: string;
}

/**
 * Local infrastructure boundary. The caller owns a cross-process lock implementation;
 * this service never asks an Agent to run Git and never builds a shell command string.
 */
export interface RepositoryWorkspaceSyncHost {
  withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T>;
  /** Must validate the real common-dir ownership/mode while the branch lock is held. */
  validateServerOwnedRepository(repositoryPath: string): Promise<void>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
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

export class RepositoryWorkspaceSyncError extends Error {
  constructor(
    message: string,
    readonly code: RepositoryWorkspaceSyncErrorCode,
    readonly command?: RepositoryWorkspaceGitCommand,
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
}

const OID_PATTERN = /^[0-9a-f]{40,64}$/;

export async function syncRepositoryWorkspace(
  host: RepositoryWorkspaceSyncHost,
  rawInput: RepositoryWorkspaceSyncInput,
): Promise<RepositoryWorkspaceSyncResult> {
  const input = validateInput(rawInput);
  return host.withRepositoryBranchLock(
    { repositoryPath: input.repositoryPath, branch: input.integrationBranch },
    () => syncLocked(host, input),
  );
}

export async function syncCandidateRevisionObjects(
  host: RepositoryWorkspaceSyncHost,
  input: CandidateRevisionObjectSyncInput,
): Promise<CandidateRevisionObjectSyncResult> {
  validateCandidateObjectSyncInput(input);
  return host.withRepositoryBranchLock(
    { repositoryPath: input.repositoryPath, branch: input.integrationBranch },
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
      if (actualBase !== input.expectedBaseOid || actualTree !== input.expectedTreeOid
        || !await isAncestor(host, input.repositoryPath, input.expectedBaseOid, remoteBaseRef)
        || !await isAncestor(host, input.repositoryPath, input.expectedBaseOid, input.expectedHeadOid)) {
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
): Promise<RepositoryWorkspaceSyncResult> {
  try {
    await host.validateServerOwnedRepository(input.repositoryPath);
  } catch (error) {
    throw new RepositoryWorkspaceSyncError(
      `Server-owned mirror validation failed: ${error instanceof Error ? error.message : String(error)}`,
      'MIRROR_UNSAFE',
    );
  }
  const remoteBaseRef = `refs/remotes/origin/${input.baseBranch}`;
  const frozenHeads = input.frozenPullRequestHeads ?? [];
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
        'WORKTREE_DIVERGED',
      );
    }
  }

  const baseRef = `refs/heads/${input.baseBranch}`;
  const integrationRef = `refs/heads/${input.integrationBranch}`;
  const baseOid = singleOid(await git(host, input.repositoryPath, ['rev-parse', '--verify', remoteBaseRef]), remoteBaseRef);
  const worktrees = parseWorktrees((await git(host, input.repositoryPath, [
    'worktree', 'list', '--porcelain',
  ])).stdout);

  assertUniqueWorktreePathsAndBranches(worktrees);
  const localBase = await refreshLocalBase(host, input.repositoryPath, baseRef, remoteBaseRef, worktrees);
  const integrationWorktree = await prepareIntegrationWorktree(
    host,
    input,
    integrationRef,
    remoteBaseRef,
    worktrees,
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

async function refreshLocalBase(
  host: RepositoryWorkspaceSyncHost,
  repositoryPath: string,
  baseRef: string,
  remoteBaseRef: string,
  worktrees: WorktreeRecord[],
): Promise<RepositoryWorkspaceSyncResult['localBase']> {
  const baseWorktree = worktrees.find((entry) => entry.branch === baseRef);
  if (!baseWorktree) return 'absent';
  await assertClean(host, baseWorktree);

  if (await isAncestor(host, repositoryPath, baseRef, remoteBaseRef)) {
    if (await isAncestor(host, repositoryPath, remoteBaseRef, baseRef)) return 'current';
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
      await git(host, atRequestedPath.path, ['reset', '--hard', remoteBaseRef]);
      return 'reset_to_base';
    }
    return fastForwardWorktree(host, input.repositoryPath, atRequestedPath.path, integrationRef, remoteBaseRef);
  }

  const branchExists = await refExists(host, input.repositoryPath, integrationRef);
  if (branchExists) {
    if (input.integrationWorktreeMode !== 'reset_to_base') {
      await assertFastForwardable(host, input.repositoryPath, integrationRef, remoteBaseRef);
    }
    await git(host, input.repositoryPath, ['worktree', 'add', '--', input.worktreePath, integrationRef]);
    if (input.integrationWorktreeMode === 'reset_to_base') {
      await git(host, input.worktreePath, ['reset', '--hard', remoteBaseRef]);
      return 'reset_to_base';
    }
    if (await isAncestor(host, input.repositoryPath, remoteBaseRef, integrationRef)) return 'created';
    await git(host, input.worktreePath, ['merge', '--ff-only', remoteBaseRef]);
    return 'fast_forwarded';
  }

  await git(host, input.repositoryPath, [
    'worktree', 'add', '-b', input.integrationBranch, '--no-track', '--', input.worktreePath, remoteBaseRef,
  ]);
  return 'created';
}

async function fastForwardWorktree(
  host: RepositoryWorkspaceSyncHost,
  repositoryPath: string,
  worktreePath: string,
  integrationRef: string,
  remoteBaseRef: string,
): Promise<'current' | 'fast_forwarded'> {
  await assertFastForwardable(host, repositoryPath, integrationRef, remoteBaseRef);
  if (await isAncestor(host, repositoryPath, remoteBaseRef, integrationRef)) return 'current';
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
  const status = await git(host, worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']);
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
      `Git command could not be executed: ${error instanceof Error ? error.message : String(error)}`,
      'GIT_COMMAND_FAILED',
      diagnosticCommand(command),
    );
  }
}

function commandFailure(
  command: RepositoryWorkspaceGitCommand,
  result: RepositoryWorkspaceGitResult,
): RepositoryWorkspaceSyncError {
  const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
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
    if (!pathLine || !headLine || (detached && branchLine)) {
      throw new RepositoryWorkspaceSyncError(`Malformed worktree record: ${block}`, 'WORKTREE_UNKNOWN');
    }
    const path = pathLine.slice('worktree '.length);
    const head = headLine.slice('HEAD '.length);
    if (!isSafeAbsolutePath(path) || !OID_PATTERN.test(head)) {
      throw new RepositoryWorkspaceSyncError(`Unsafe worktree record: ${block}`, 'WORKTREE_UNKNOWN');
    }
    const branch = branchLine?.slice('branch '.length);
    if (branch && !branch.startsWith('refs/heads/')) {
      throw new RepositoryWorkspaceSyncError(`Unknown worktree branch: ${branch}`, 'WORKTREE_UNKNOWN');
    }
    return { path, head, branch, detached };
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
