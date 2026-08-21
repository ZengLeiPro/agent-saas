import { createHash } from 'node:crypto';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';

export type RepositoryCheckStatus = 'pending' | 'success' | 'failure';

/** Canonical GitHub identity parser. Deliberately rejects URL suffix matching, ports,
 * userinfo, query/fragment, encoded path separators and all non-GitHub hosts. */
export function canonicalGithubRepositoryUrl(repository: Pick<TaskBoardRepositoryConfig, 'owner' | 'name'>): string {
  assertGithubPathComponent(repository.owner, 'owner');
  assertGithubPathComponent(repository.name, 'name');
  return `https://github.com/${repository.owner}/${repository.name}.git`;
}

export function isCanonicalGithubRepositoryRemote(
  value: string,
  repository: Pick<TaskBoardRepositoryConfig, 'owner' | 'name'>,
): boolean {
  const expectedPath = `/${repository.owner}/${repository.name}`;
  try {
    if (/^git@github\.com:/.test(value)) {
      const path = value.slice('git@github.com:'.length).replace(/\.git$/, '');
      return !/[?#@\\]/.test(path) && `/${path}` === expectedPath;
    }
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\.git$/, '');
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'github.com'
      && parsed.port === '' && parsed.username === '' && parsed.password === ''
      && parsed.search === '' && parsed.hash === ''
      && !/%2f|%5c/i.test(parsed.pathname)
      && path === expectedPath;
  } catch { return false; }
}

function assertGithubPathComponent(value: string, label: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(value) || value === '.' || value === '..') {
    throw new RepositoryProviderPolicyError(`Invalid GitHub repository ${label}`);
  }
}

export interface RepositoryRequiredCheck {
  name: string;
  status: RepositoryCheckStatus;
  appId?: number;
}

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
  requiredChecks: RepositoryRequiredCheck[];
  /** False means the provider could not authoritatively determine the required gate set. */
  requiredChecksKnown?: boolean;
  subjectDigest: string;
}

export interface RepositoryReferenceSnapshot {
  ref: string;
  oid: string;
  treeOid: string;
}

export interface RepositoryRequiredGateCapabilities {
  known: boolean;
  requiredChecks: Array<{ name: string; appId?: number }>;
  mergeQueueRequired: boolean;
  unsupportedRules: string[];
}

export interface RepositoryBranchReceipt {
  operationKey: string;
  ref: string;
  oid: string;
  treeOid: string;
  created: boolean;
  raw: Record<string, unknown>;
}

export interface RepositoryIntegrationPullRequestReceipt {
  operationKey: string;
  providerPullRequestId: string;
  number: number;
  headRef: string;
  headOid: string;
  baseRef: string;
  created: boolean;
  raw: Record<string, unknown>;
}

export interface RepositoryWriteReceipt {
  operationKey: string;
  providerPullRequestId: string;
  raw: Record<string, unknown>;
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
  getPullRequest(repository: TaskBoardRepositoryConfig, providerPullRequestId: string, credentialOwnerId: string): Promise<RepositoryPullRequestSnapshot>;
  getReference?(repository: TaskBoardRepositoryConfig, ref: string, credentialOwnerId: string): Promise<RepositoryReferenceSnapshot>;
  getBaseReference?(repository: TaskBoardRepositoryConfig, credentialOwnerId: string): Promise<RepositoryReferenceSnapshot>;
  getRequiredGateCapabilities?(repository: TaskBoardRepositoryConfig, baseRef: string, credentialOwnerId: string): Promise<RepositoryRequiredGateCapabilities>;
  ensureIntegrationBranch?(repository: TaskBoardRepositoryConfig, input: {
    ref: string;
    expectedBaseOid: string;
    expectedBaseTreeOid: string;
    operationKey: string;
  }, credentialOwnerId: string): Promise<RepositoryBranchReceipt>;
  findIntegrationPullRequest?(repository: TaskBoardRepositoryConfig, input: {
    headRef: string;
    baseRef: string;
    expectedHeadOid: string;
  }, credentialOwnerId: string): Promise<RepositoryIntegrationPullRequestReceipt | undefined>;
  ensureIntegrationPullRequest?(repository: TaskBoardRepositoryConfig, input: {
    headRef: string;
    baseRef: string;
    expectedHeadOid: string;
    title: string;
    body: string;
    operationKey: string;
  }, credentialOwnerId: string): Promise<RepositoryIntegrationPullRequestReceipt>;
  closePullRequest?(repository: TaskBoardRepositoryConfig, input: { providerPullRequestId: string; operationKey: string }, credentialOwnerId: string): Promise<RepositoryWriteReceipt>;
  commentPullRequest?(repository: TaskBoardRepositoryConfig, input: { providerPullRequestId: string; body: string; operationKey: string }, credentialOwnerId: string): Promise<RepositoryWriteReceipt>;
  mergePullRequest(repository: TaskBoardRepositoryConfig, input: {
    providerPullRequestId: string;
    expectedHeadOid: string;
    method: 'merge' | 'squash' | 'rebase';
    requestId: string;
    operationKey?: string;
  }, credentialOwnerId: string): Promise<RepositoryMergeReceipt>;
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

  async getPullRequest(repository: TaskBoardRepositoryConfig, providerPullRequestId: string, credentialOwnerId: string): Promise<RepositoryPullRequestSnapshot> {
    const number = parsePullRequestNumber(providerPullRequestId);
    const pullRecord = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, `/pulls/${number}`)));
    const headOid = requiredString(pullRecord.head, 'sha', 'GitHub pull request head OID');
    const baseOid = requiredString(pullRecord.base, 'sha', 'GitHub pull request base OID');
    const baseRef = requiredString(pullRecord.base, 'ref', 'GitHub pull request base ref');
    const headRef = requiredString(pullRecord.head, 'ref', 'GitHub pull request head ref');
    this.assertPullRequestPolicy(repository, pullRecord, baseRef);

    const [checksResult, statusesResult, requiredResult] = await Promise.allSettled([
      this.request(repository, credentialOwnerId, this.repoPath(repository, `/commits/${encodeURIComponent(headOid)}/check-runs`)),
      this.request(repository, credentialOwnerId, this.repoPath(repository, `/commits/${encodeURIComponent(headOid)}/status`)),
      this.request(repository, credentialOwnerId, this.repoPath(repository, `/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`)),
    ]);
    let requiredKnown = requiredResult.status === 'fulfilled';
    let rulesetsValue: unknown;
    const protectionHasNoChecks = requiredResult.status === 'fulfilled'
      && normalizeRequiredCheckIdentities(requiredResult.value).length === 0;
    const protectionUnavailable = requiredResult.status === 'rejected'
      && isUnavailableGithubPolicyFeature(requiredResult.reason);
    if (protectionHasNoChecks
      || protectionUnavailable
      || (requiredResult.status === 'rejected' && requiredResult.reason instanceof GithubApiError && requiredResult.reason.status === 404)) {
      try {
        rulesetsValue = await this.getRulesetDetails(repository, credentialOwnerId);
        requiredKnown = !rulesetsRequireUnknownStatusChecks(rulesetsValue);
      } catch (error) {
        rulesetsValue = [];
        requiredKnown = protectionUnavailable && isUnavailableGithubPolicyFeature(error);
      }
    }
    const requiredChecks = normalizeChecks(
      checksResult.status === 'fulfilled' ? checksResult.value : undefined,
      statusesResult.status === 'fulfilled' ? statusesResult.value : undefined,
      requiredResult.status === 'fulfilled' ? requiredResult.value : undefined,
    );
    const requiredChecksKnown = requiredKnown && checksResult.status === 'fulfilled' && statusesResult.status === 'fulfilled';
    if (!requiredChecksKnown) requiredChecks.push({ name: 'github:checks-unavailable', status: 'failure' });

    const numberFromProvider = Number(pullRecord.number);
    if (!Number.isInteger(numberFromProvider) || numberFromProvider !== number) throw new Error('GitHub pull request number is missing or inconsistent');
    const merged = pullRecord.merged === true;
    return {
      providerPullRequestId: String(number), number,
      state: merged ? 'merged' : pullRecord.state === 'closed' ? 'closed' : 'open',
      draft: pullRecord.draft === true,
      headRef, headOid, baseRef, baseOid,
      ...(pullRecord.merge_commit_sha ? { mergeCommitOid: String(pullRecord.merge_commit_sha) } : {}),
      mergeable: typeof pullRecord.mergeable === 'boolean' ? pullRecord.mergeable : null,
      ...(pullRecord.mergeable_state ? { mergeableState: String(pullRecord.mergeable_state) } : {}),
      requiredChecks, requiredChecksKnown,
      subjectDigest: repositorySubjectDigest({ repositoryId: repository.repositoryId, providerPullRequestId: String(number), number, headOid, baseRef, baseOid }),
    };
  }

  async getReference(repository: TaskBoardRepositoryConfig, ref: string, credentialOwnerId: string): Promise<RepositoryReferenceSnapshot> {
    const normalizedRef = normalizeBranchRef(ref);
    const refPayload = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, `/git/ref/heads/${encodeRefPath(normalizedRef)}`)));
    const oid = requiredString(refPayload.object, 'sha', `GitHub ref ${normalizedRef} OID`);
    const commit = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, `/git/commits/${encodeURIComponent(oid)}`)));
    const treeOid = requiredString(commit.tree, 'sha', `GitHub ref ${normalizedRef} tree OID`);
    return { ref: normalizedRef, oid, treeOid };
  }

  getBaseReference(repository: TaskBoardRepositoryConfig, credentialOwnerId: string): Promise<RepositoryReferenceSnapshot> {
    return this.getReference(repository, repository.baseBranch, credentialOwnerId);
  }

  async getRequiredGateCapabilities(repository: TaskBoardRepositoryConfig, baseRef: string, credentialOwnerId: string): Promise<RepositoryRequiredGateCapabilities> {
    const normalizedBase = normalizeBranchRef(baseRef);
    const [protection, rulesets] = await Promise.allSettled([
      this.request(repository, credentialOwnerId, this.repoPath(repository, `/branches/${encodeURIComponent(normalizedBase)}/protection/required_status_checks`)),
      this.getRulesetDetails(repository, credentialOwnerId),
    ]);
    const protectionAbsent = protection.status === 'rejected'
      && (protection.reason instanceof GithubApiError && protection.reason.status === 404
        || isUnavailableGithubPolicyFeature(protection.reason));
    const rulesetsAbsent = rulesets.status === 'rejected' && isUnavailableGithubPolicyFeature(rulesets.reason);
    if ((!protectionAbsent && protection.status === 'rejected')
      || (!rulesetsAbsent && rulesets.status === 'rejected')) {
      return { known: false, requiredChecks: [], mergeQueueRequired: false, unsupportedRules: ['provider-gates-unavailable'] };
    }
    const checks = normalizeRequiredCheckIdentities(protection.status === 'fulfilled' ? protection.value : undefined);
    const ruleFacts = inspectRulesets(rulesets.status === 'fulfilled' ? rulesets.value : []);
    for (const check of ruleFacts.requiredChecks) if (!checks.some((item) => item.name === check.name && item.appId === check.appId)) checks.push(check);
    return { known: ruleFacts.known, requiredChecks: checks.sort(compareChecks), mergeQueueRequired: ruleFacts.mergeQueueRequired, unsupportedRules: ruleFacts.unsupportedRules };
  }

  async ensureIntegrationBranch(repository: TaskBoardRepositoryConfig, input: { ref: string; expectedBaseOid: string; expectedBaseTreeOid: string; operationKey: string }, credentialOwnerId: string): Promise<RepositoryBranchReceipt> {
    assertOperationKey(input.operationKey);
    const ref = normalizeBranchRef(input.ref);
    const base = await this.getBaseReference(repository, credentialOwnerId);
    if (base.oid !== input.expectedBaseOid || base.treeOid !== input.expectedBaseTreeOid) throw new RepositoryProviderDriftError('Integration base ref changed before branch creation');
    const existing = await this.tryGetReference(repository, ref, credentialOwnerId);
    if (existing) {
      if (existing.oid !== input.expectedBaseOid || existing.treeOid !== input.expectedBaseTreeOid) throw new RepositoryProviderDriftError('Existing integration branch does not match the prepared base');
      return { operationKey: input.operationKey, ...existing, created: false, raw: {} };
    }
    const payload = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, '/git/refs'), {
      method: 'POST', body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: input.expectedBaseOid }),
    }));
    const oid = requiredString(payload.object, 'sha', 'created integration branch OID');
    if (oid !== input.expectedBaseOid) throw new RepositoryProviderDriftError('Created integration branch has an unexpected OID');
    return { operationKey: input.operationKey, ref, oid, treeOid: input.expectedBaseTreeOid, created: true, raw: payload };
  }

  async findIntegrationPullRequest(repository: TaskBoardRepositoryConfig, input: { headRef: string; baseRef: string; expectedHeadOid: string }, credentialOwnerId: string): Promise<RepositoryIntegrationPullRequestReceipt | undefined> {
    const headRef = normalizeBranchRef(input.headRef);
    const baseRef = normalizeBranchRef(input.baseRef);
    const query = new URLSearchParams({ state: 'all', head: `${repository.owner}:${headRef}`, base: baseRef, per_page: '100' });
    const value = await this.request(repository, credentialOwnerId, this.repoPath(repository, `/pulls?${query}`));
    if (!Array.isArray(value)) throw new Error('GitHub pull request search returned an invalid response');
    const matches = value.map(asRecord).filter((pull) => String(asRecord(pull.head).ref ?? '') === headRef && String(asRecord(pull.base).ref ?? '') === baseRef);
    if (matches.length > 1) throw new RepositoryProviderDuplicateError('More than one Integration PR exists for the integration branch');
    if (!matches[0]) return undefined;
    const headOid = requiredString(matches[0].head, 'sha', 'Integration PR head OID');
    if (headOid !== input.expectedHeadOid) throw new RepositoryProviderDriftError('Integration PR head changed from the prepared OID');
    const number = Number(matches[0].number);
    if (!Number.isInteger(number) || number < 1) throw new Error('Integration PR number is missing');
    return { operationKey: '', providerPullRequestId: String(number), number, headRef, headOid, baseRef, created: false, raw: matches[0] };
  }

  async ensureIntegrationPullRequest(repository: TaskBoardRepositoryConfig, input: { headRef: string; baseRef: string; expectedHeadOid: string; title: string; body: string; operationKey: string }, credentialOwnerId: string): Promise<RepositoryIntegrationPullRequestReceipt> {
    assertOperationKey(input.operationKey);
    const head = await this.getReference(repository, input.headRef, credentialOwnerId);
    const base = await this.getReference(repository, input.baseRef, credentialOwnerId);
    if (head.oid !== input.expectedHeadOid) throw new RepositoryProviderDriftError('Integration branch changed before PR creation');
    if (base.ref !== repository.baseBranch) throw new RepositoryProviderPolicyError('Integration PR base is outside repository policy');
    const existing = await this.findIntegrationPullRequest(repository, input, credentialOwnerId);
    if (existing) return { ...existing, operationKey: input.operationKey };
    const payload = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, '/pulls'), {
      method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, head: head.ref, base: base.ref }),
    }));
    const number = Number(payload.number);
    const headOid = requiredString(payload.head, 'sha', 'created Integration PR head OID');
    if (!Number.isInteger(number) || number < 1 || headOid !== input.expectedHeadOid) throw new RepositoryProviderDriftError('Created Integration PR does not match the prepared head');
    return { operationKey: input.operationKey, providerPullRequestId: String(number), number, headRef: head.ref, headOid, baseRef: base.ref, created: true, raw: payload };
  }

  async closePullRequest(repository: TaskBoardRepositoryConfig, input: { providerPullRequestId: string; operationKey: string }, credentialOwnerId: string): Promise<RepositoryWriteReceipt> {
    assertOperationKey(input.operationKey);
    const number = parsePullRequestNumber(input.providerPullRequestId);
    const raw = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, `/pulls/${number}`), { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }));
    return { operationKey: input.operationKey, providerPullRequestId: String(number), raw };
  }

  async commentPullRequest(repository: TaskBoardRepositoryConfig, input: { providerPullRequestId: string; body: string; operationKey: string }, credentialOwnerId: string): Promise<RepositoryWriteReceipt> {
    assertOperationKey(input.operationKey);
    const number = parsePullRequestNumber(input.providerPullRequestId);
    const raw = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, `/issues/${number}/comments`), { method: 'POST', body: JSON.stringify({ body: input.body }) }));
    return { operationKey: input.operationKey, providerPullRequestId: String(number), raw };
  }

  async mergePullRequest(repository: TaskBoardRepositoryConfig, input: { providerPullRequestId: string; expectedHeadOid: string; method: 'merge' | 'squash' | 'rebase'; requestId: string; operationKey?: string }, credentialOwnerId: string): Promise<RepositoryMergeReceipt> {
    const number = parsePullRequestNumber(input.providerPullRequestId);
    assertOperationKey(input.operationKey ?? input.requestId);
    const payload = asRecord(await this.request(repository, credentialOwnerId, this.repoPath(repository, `/pulls/${number}/merge`), {
      method: 'PUT', body: JSON.stringify({ sha: input.expectedHeadOid, merge_method: input.method }),
      // Kept for v2 wire compatibility only. Correctness comes from the semantic operation ledger;
      // GitHub does not document this as a generic idempotency guarantee.
      headers: { 'Idempotency-Key': input.operationKey ?? input.requestId },
    }));
    return { providerRequestId: input.operationKey ?? input.requestId, providerPullRequestId: input.providerPullRequestId, merged: payload.merged === true, ...(payload.sha ? { mergedCommitOid: String(payload.sha) } : {}), ...(payload.message ? { message: String(payload.message) } : {}), raw: payload };
  }

  private async getRulesetDetails(repository: TaskBoardRepositoryConfig, credentialOwnerId: string): Promise<unknown[]> {
    const summaries = await this.request(repository, credentialOwnerId, this.repoPath(repository, '/rulesets?includes_parents=true'));
    if (!Array.isArray(summaries)) throw new Error('GitHub rulesets response is invalid');
    return Promise.all(summaries.map(async (summary) => {
      const id = Number(asRecord(summary).id);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('GitHub ruleset id is missing');
      return this.request(repository, credentialOwnerId, this.repoPath(repository, `/rulesets/${id}?includes_parents=true`));
    }));
  }

  private async tryGetReference(repository: TaskBoardRepositoryConfig, ref: string, credentialOwnerId: string): Promise<RepositoryReferenceSnapshot | undefined> {
    try { return await this.getReference(repository, ref, credentialOwnerId); }
    catch (error) { if (error instanceof GithubApiError && error.status === 404) return undefined; throw error; }
  }

  private assertPullRequestPolicy(repository: TaskBoardRepositoryConfig, pull: Record<string, unknown>, baseRef: string): void {
    const repositoryName = `${repository.owner}/${repository.name}`.toLowerCase();
    const headRepository = String(asRecord(asRecord(pull.head).repo).full_name ?? '').toLowerCase();
    const baseRepository = String(asRecord(asRecord(pull.base).repo).full_name ?? '').toLowerCase();
    if (baseRef !== repository.baseBranch || baseRepository !== repositoryName) throw new RepositoryProviderPolicyError('GitHub pull request targets a repository or branch outside the board policy');
    if (!repository.allowForkPullRequest && headRepository !== repositoryName) throw new RepositoryProviderPolicyError('Fork pull requests are not allowed by the board policy');
  }

  private repoPath(repository: TaskBoardRepositoryConfig, suffix: string): string { return `/repos/${repository.owner}/${repository.name}${suffix}`; }

  private async request(repository: TaskBoardRepositoryConfig, credentialOwnerId: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.options.resolveToken(repository, credentialOwnerId);
    if (!token) throw new Error('GitHub repository credential is unavailable');
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agent-saas-taskboard-provider', ...init.headers } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new GithubApiError(response.status, payload && typeof payload === 'object' && 'message' in payload ? String((payload as { message: unknown }).message) : `GitHub API ${response.status}`);
    return payload;
  }
}

export function repositorySubjectDigest(input: { repositoryId: string; providerPullRequestId: string; number: number; headOid: string; baseRef: string; baseOid: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export class GithubApiError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'GithubApiError'; } }
function isUnavailableGithubPolicyFeature(error: unknown): boolean {
  if (!(error instanceof GithubApiError) || error.status !== 403) return false;
  const message = error.message.toLowerCase();
  return message.includes('upgrade to github pro') && message.includes('make this repository public');
}
export class RepositoryProviderDriftError extends Error { constructor(message: string) { super(message); this.name = 'RepositoryProviderDriftError'; } }
export class RepositoryProviderDuplicateError extends Error { constructor(message: string) { super(message); this.name = 'RepositoryProviderDuplicateError'; } }
export class RepositoryProviderPolicyError extends Error { constructor(message: string) { super(message); this.name = 'RepositoryProviderPolicyError'; } }

function parsePullRequestNumber(value: string): number { const match = value.match(/(?:^|\/)(\d+)$/); const number = Number(match?.[1] ?? value); if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid GitHub pull request id: ${value}`); return number; }
function normalizeBranchRef(value: string): string { const ref = value.replace(/^refs\/heads\//, ''); if (!ref || ref.startsWith('/') || ref.endsWith('/') || ref.includes('..') || ref.includes('~') || ref.includes('^') || ref.includes(':') || ref.includes('\\') || ref.includes('//') || /[\x00-\x20\x7f]/.test(ref)) throw new RepositoryProviderPolicyError(`Invalid branch ref: ${value}`); return ref; }
function encodeRefPath(ref: string): string { return ref.split('/').map(encodeURIComponent).join('/'); }
function assertOperationKey(value: string): void { if (!value || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new Error('A valid semantic provider operation key is required'); }
function asRecord(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
function requiredString(container: unknown, key: string, label: string): string { const value = String(asRecord(container)[key] ?? ''); if (!value) throw new Error(`${label} is missing`); return value; }
function checkIdentityKey(name: string, appId?: number): string { return `${name}\u0000${appId ?? '*'}`; }
function compareChecks(a: { name: string; appId?: number }, b: { name: string; appId?: number }): number { return checkIdentityKey(a.name, a.appId).localeCompare(checkIdentityKey(b.name, b.appId)); }

function normalizeChecks(checksValue: unknown, statusesValue: unknown, requiredValue: unknown): RepositoryRequiredCheck[] {
  const observed = new Map<string, RepositoryCheckStatus>();
  const runs = asRecord(checksValue).check_runs;
  if (Array.isArray(runs)) for (const item of runs) { const run = asRecord(item); const name = String(run.name ?? 'check'); const appId = Number(asRecord(run.app).id); const conclusion = String(run.conclusion ?? ''); const status: RepositoryCheckStatus = run.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(conclusion) ? 'success' : 'failure'; observed.set(checkIdentityKey(name, Number.isInteger(appId) ? appId : undefined), status); observed.set(checkIdentityKey(name), status); }
  const statuses = asRecord(statusesValue).statuses;
  if (Array.isArray(statuses)) for (const item of statuses) { const status = asRecord(item); const name = String(status.context ?? 'status'); const state = String(status.state ?? 'pending'); observed.set(checkIdentityKey(name), state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure'); }
  const required = normalizeRequiredCheckIdentities(requiredValue);
  const identities: Array<{ name: string; appId?: number }> = required.length
    ? required
    : [...new Set([...observed.keys()].filter((key) => key.endsWith('\u0000*')).map((key) => key.slice(0, -2)))].map((name) => ({ name }));
  return identities.sort(compareChecks).map((identity) => ({ ...identity, status: observed.get(checkIdentityKey(identity.name, identity.appId)) ?? observed.get(checkIdentityKey(identity.name)) ?? 'pending' }));
}

function normalizeRequiredCheckIdentities(value: unknown): Array<{ name: string; appId?: number }> {
  const record = asRecord(value); const result = new Map<string, { name: string; appId?: number }>();
  if (Array.isArray(record.contexts)) for (const context of record.contexts) { const item = { name: String(context) }; result.set(checkIdentityKey(item.name), item); }
  if (Array.isArray(record.checks)) for (const raw of record.checks) { const check = asRecord(raw); if (!check.context) continue; const appId = Number(check.app_id); const item = { name: String(check.context), ...(Number.isInteger(appId) ? { appId } : {}) }; result.set(checkIdentityKey(item.name, item.appId), item); }
  return [...result.values()];
}

function inspectRulesets(value: unknown): { known: boolean; requiredChecks: Array<{ name: string; appId?: number }>; mergeQueueRequired: boolean; unsupportedRules: string[] } {
  if (!Array.isArray(value)) return { known: false, requiredChecks: [], mergeQueueRequired: false, unsupportedRules: ['invalid-rulesets-response'] };
  const requiredChecks: Array<{ name: string; appId?: number }> = []; const unsupported = new Set<string>(); let mergeQueueRequired = false;
  for (const rawSet of value) { const set = asRecord(rawSet); const rules = set.rules; if (!Array.isArray(rules)) continue; for (const rawRule of rules) { const rule = asRecord(rawRule); const type = String(rule.type ?? ''); if (type === 'required_status_checks') { const parameters = asRecord(rule.parameters); const checks = parameters.required_status_checks; if (!Array.isArray(checks)) { unsupported.add('ruleset-required-status-checks-unresolved'); continue; } for (const rawCheck of checks) { const check = asRecord(rawCheck); if (!check.context) continue; const appId = Number(check.integration_id); requiredChecks.push({ name: String(check.context), ...(Number.isInteger(appId) ? { appId } : {}) }); } } else if (type === 'merge_queue') mergeQueueRequired = true; else if (['required_deployments', 'required_signatures', 'required_code_scanning'].includes(type)) unsupported.add(type); } }
  return { known: unsupported.size === 0, requiredChecks, mergeQueueRequired, unsupportedRules: [...unsupported].sort() };
}
function rulesetsRequireUnknownStatusChecks(value: unknown): boolean { const facts = inspectRulesets(value); return !facts.known || facts.requiredChecks.length > 0; }
