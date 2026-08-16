import { createHash } from 'node:crypto';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';

export interface RepositoryPullRequestSnapshot {
  providerPullRequestId: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headRef: string;
  headOid: string;
  baseRef: string;
  baseOid: string;
  mergeCommitOid?: string;
  mergeable: boolean | null;
  mergeableState?: string;
  requiredChecks: Array<{ name: string; status: 'pending' | 'success' | 'failure' }>;
  subjectDigest: string;
}

export interface RepositoryMergeReceipt {
  providerRequestId: string;
  providerPullRequestId: string;
  merged: boolean;
  mergedCommitOid?: string;
  message?: string;
  raw: Record<string, unknown>;
}

export interface RepositoryProvider {
  getPullRequest(
    repository: TaskBoardRepositoryConfig,
    providerPullRequestId: string,
    credentialOwnerId: string,
  ): Promise<RepositoryPullRequestSnapshot>;
  mergePullRequest(
    repository: TaskBoardRepositoryConfig,
    input: {
      providerPullRequestId: string;
      expectedHeadOid: string;
      method: 'merge' | 'squash' | 'rebase';
      requestId: string;
    },
    credentialOwnerId: string,
  ): Promise<RepositoryMergeReceipt>;
}

export interface GithubRepositoryProviderOptions {
  resolveToken(repository: TaskBoardRepositoryConfig, credentialOwnerId: string): Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

export class GithubRepositoryProvider implements RepositoryProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GithubRepositoryProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async getPullRequest(
    repository: TaskBoardRepositoryConfig,
    providerPullRequestId: string,
    credentialOwnerId: string,
  ): Promise<RepositoryPullRequestSnapshot> {
    const number = parsePullRequestNumber(providerPullRequestId);
    const pull = await this.request(
      repository,
      credentialOwnerId,
      `/repos/${repository.owner}/${repository.name}/pulls/${number}`,
    );
    const pullRecord = pull as Record<string, any>;
    const headOid = String(pullRecord.head?.sha ?? '');
    const baseRef = String(pullRecord.base?.ref ?? repository.baseBranch);
    const repositoryName = `${repository.owner}/${repository.name}`.toLowerCase();
    const headRepository = String(pullRecord.head?.repo?.full_name ?? '').toLowerCase();
    const baseRepository = String(pullRecord.base?.repo?.full_name ?? '').toLowerCase();
    if (!headOid || !String(pullRecord.base?.sha ?? '')) {
      throw new Error('GitHub pull request is missing immutable commit identifiers');
    }
    if (baseRef !== repository.baseBranch || baseRepository !== repositoryName) {
      throw new Error('GitHub pull request targets a repository or branch outside the board policy');
    }
    if (!repository.allowForkPullRequest && headRepository !== repositoryName) {
      throw new Error('Fork pull requests are not allowed by the board policy');
    }
    const [checksResult, statusesResult, requiredResult] = await Promise.allSettled([
      this.request(repository, credentialOwnerId, `/repos/${repository.owner}/${repository.name}/commits/${headOid}/check-runs`),
      this.request(repository, credentialOwnerId, `/repos/${repository.owner}/${repository.name}/commits/${headOid}/status`),
      this.request(repository, credentialOwnerId, `/repos/${repository.owner}/${repository.name}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`),
    ]);
    const requiredUnavailable = requiredResult.status === 'rejected'
      && (!(requiredResult.reason instanceof GithubApiError) || requiredResult.reason.status !== 404);
    const requiredChecks = normalizeChecks(
      checksResult.status === 'fulfilled' ? checksResult.value : undefined,
      statusesResult.status === 'fulfilled' ? statusesResult.value : undefined,
      requiredResult.status === 'fulfilled' ? requiredResult.value : undefined,
    );
    if (checksResult.status === 'rejected' || statusesResult.status === 'rejected' || requiredUnavailable) {
      requiredChecks.push({ name: 'github:checks-unavailable', status: 'failure' });
    }
    const merged = pullRecord.merged === true;
    const state = merged ? 'merged' : pullRecord.state === 'closed' ? 'closed' : 'open';
    const baseOid = String(pullRecord.base?.sha ?? '');
    return {
      providerPullRequestId: String(number),
      number,
      state,
      draft: pullRecord.draft === true,
      headRef: String(pullRecord.head?.ref ?? ''),
      headOid,
      baseRef,
      baseOid,
      ...(pullRecord.merge_commit_sha ? { mergeCommitOid: String(pullRecord.merge_commit_sha) } : {}),
      mergeable: typeof pullRecord.mergeable === 'boolean' ? pullRecord.mergeable : null,
      ...(pullRecord.mergeable_state ? { mergeableState: String(pullRecord.mergeable_state) } : {}),
      requiredChecks,
      subjectDigest: repositorySubjectDigest({
        repositoryId: repository.repositoryId,
        providerPullRequestId: String(number),
        number,
        headOid,
        baseRef,
        baseOid,
      }),
    };
  }

  async mergePullRequest(
    repository: TaskBoardRepositoryConfig,
    input: {
      providerPullRequestId: string;
      expectedHeadOid: string;
      method: 'merge' | 'squash' | 'rebase';
      requestId: string;
    },
    credentialOwnerId: string,
  ): Promise<RepositoryMergeReceipt> {
    const number = parsePullRequestNumber(input.providerPullRequestId);
    const response = await this.request(
      repository,
      credentialOwnerId,
      `/repos/${repository.owner}/${repository.name}/pulls/${number}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ sha: input.expectedHeadOid, merge_method: input.method }),
        headers: { 'Idempotency-Key': input.requestId },
      },
    );
    const payload = response as Record<string, unknown>;
    return {
      providerRequestId: input.requestId,
      providerPullRequestId: input.providerPullRequestId,
      merged: payload.merged === true,
      ...(payload.sha ? { mergedCommitOid: String(payload.sha) } : {}),
      ...(payload.message ? { message: String(payload.message) } : {}),
      raw: payload,
    };
  }

  private async request(
    repository: TaskBoardRepositoryConfig,
    credentialOwnerId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const token = await this.options.resolveToken(repository, credentialOwnerId);
    if (!token) throw new Error('GitHub repository credential is unavailable');
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'agent-saas-taskboard-provider',
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `GitHub API ${response.status}`;
      throw new GithubApiError(response.status, message);
    }
    return payload;
  }
}

export function repositorySubjectDigest(input: {
  repositoryId: string;
  providerPullRequestId: string;
  number: number;
  headOid: string;
  baseRef: string;
  baseOid: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    repositoryId: input.repositoryId,
    providerPullRequestId: input.providerPullRequestId,
    number: input.number,
    headOid: input.headOid,
    baseRef: input.baseRef,
    baseOid: input.baseOid,
  })).digest('hex');
}

class GithubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
  }
}

function parsePullRequestNumber(value: string): number {
  const match = value.match(/(?:^|\/)(\d+)$/);
  const number = Number(match?.[1] ?? value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid GitHub pull request id: ${value}`);
  return number;
}

function normalizeChecks(
  checksValue: unknown,
  statusesValue: unknown,
  requiredValue: unknown,
): RepositoryPullRequestSnapshot['requiredChecks'] {
  const checks = new Map<string, 'pending' | 'success' | 'failure'>();
  const runs = checksValue && typeof checksValue === 'object'
    ? (checksValue as { check_runs?: unknown }).check_runs
    : undefined;
  if (Array.isArray(runs)) {
    for (const entry of runs) {
      const run = entry as Record<string, unknown>;
      const conclusion = String(run.conclusion ?? '');
      checks.set(
        String(run.name ?? 'check'),
        run.status !== 'completed'
          ? 'pending'
          : conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped'
            ? 'success'
            : 'failure',
      );
    }
  }
  const statuses = statusesValue && typeof statusesValue === 'object'
    ? (statusesValue as { statuses?: unknown }).statuses
    : undefined;
  if (Array.isArray(statuses)) {
    for (const entry of statuses) {
      const status = entry as Record<string, unknown>;
      const state = String(status.state ?? 'pending');
      checks.set(
        String(status.context ?? 'status'),
        state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure',
      );
    }
  }
  const required = new Set<string>();
  if (requiredValue && typeof requiredValue === 'object') {
    const record = requiredValue as { contexts?: unknown; checks?: unknown };
    if (Array.isArray(record.contexts)) {
      for (const context of record.contexts) required.add(String(context));
    }
    if (Array.isArray(record.checks)) {
      for (const check of record.checks) {
        if (check && typeof check === 'object' && 'context' in check) {
          required.add(String((check as { context: unknown }).context));
        }
      }
    }
  }
  const names = required.size ? [...required] : [...checks.keys()];
  return names.sort().map((name) => ({ name, status: checks.get(name) ?? 'pending' }));
}
