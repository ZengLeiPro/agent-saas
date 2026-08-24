import { createHash, randomUUID } from 'node:crypto';

import type { IntegrationCandidateMutationFence } from './integrationCandidateStore.js';
import { redactDurableJson, redactDurableSecrets } from './durableSecretRedaction.js';

/**
 * Provider operation ledger core. This module deliberately knows nothing about SQL;
 * an integration layer must implement the CAS storage host and its transaction/fences.
 */
export type IntegrationProviderOperationKind =
  | 'create_branch'
  | 'create_pull_request'
  | 'update_ref'
  | 'push_ref'
  | 'merge_pull_request'
  | 'close_source_pull_request'
  | 'comment_source_pull_request';

export type IntegrationProviderOperationState =
  | 'prepared'
  | 'executing'
  | 'succeeded'
  | 'unknown'
  | 'failed'
  | 'needs_human';

export interface IntegrationProviderOperationFence {
  workflowEpoch: number;
  laneEpoch: number;
  candidateId: string;
  candidateRevision: number;
  executionId: string;
}

export interface IntegrationProviderOperationIntent {
  operationKey: string;
  kind: IntegrationProviderOperationKind;
  repositoryId: string;
  fence: IntegrationProviderOperationFence;
  expected: Record<string, unknown>;
  command: Record<string, unknown>;
}

export interface IntegrationProviderOperationRecord extends IntegrationProviderOperationIntent {
  id: string;
  intentDigest: string;
  state: IntegrationProviderOperationState;
  attemptCount: number;
  receipt?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationProviderOperationStorageHost {
  /** Must return the row for a globally unique semantic operation key. */
  getByOperationKey(operationKey: string): Promise<IntegrationProviderOperationRecord | undefined>;
  /** Must enforce unique(operation_key); returns the winning row on a race. */
  insertPrepared(record: IntegrationProviderOperationRecord): Promise<IntegrationProviderOperationRecord>;
  /** Atomic state CAS. Returns undefined when expectedState did not match. */
  compareAndSet(input: {
    id: string;
    expectedState: IntegrationProviderOperationState;
    nextState: IntegrationProviderOperationState;
    patch: Pick<IntegrationProviderOperationRecord, 'attemptCount' | 'updatedAt'> & {
      receipt?: Record<string, unknown>;
      error?: string;
    };
    /** When present, the operation state transition and Candidate Worker lease check are one CAS. */
    mutationFence?: IntegrationCandidateMutationFence;
  }): Promise<IntegrationProviderOperationRecord | undefined>;
}

export interface IntegrationProviderOperationFenceHost {
  /** Re-read durable workflow/lane/candidate/execution fences immediately before a provider write or reconcile commit. */
  assertCurrent(operation: IntegrationProviderOperationRecord): Promise<void>;
}

export interface IntegrationProviderAttemptOptions {
  isDefinitiveFailure?: (error: unknown) => boolean;
  /** Ephemeral Worker lease guard; deliberately excluded from the durable semantic intent. */
  assertAttemptCurrent?: () => Promise<void>;
  /** Atomically fences every provider-operation ledger CAS to the current Candidate Worker lease. */
  mutationFence?: IntegrationCandidateMutationFence;
}

export type IntegrationProviderReconcileResult =
  | { status: 'succeeded'; receipt: Record<string, unknown> }
  | { status: 'not_applied'; detail: string; evidence: Record<string, unknown> }
  | { status: 'not_found'; detail?: string }
  | { status: 'mismatch'; detail: string; evidence?: Record<string, unknown> }
  | { status: 'indeterminate'; detail: string };

export class IntegrationProviderOperationService {
  constructor(
    private readonly storage: IntegrationProviderOperationStorageHost,
    private readonly fences: IntegrationProviderOperationFenceHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(operationKey: string): Promise<IntegrationProviderOperationRecord | undefined> {
    return this.storage.getByOperationKey(operationKey);
  }

  async prepare(intent: IntegrationProviderOperationIntent): Promise<IntegrationProviderOperationRecord> {
    validateIntent(intent);
    const intentDigest = integrationProviderIntentDigest(intent);
    const existing = await this.storage.getByOperationKey(intent.operationKey);
    if (existing) return assertSameIntent(existing, intentDigest);
    const timestamp = this.now().toISOString();
    const inserted = await this.storage.insertPrepared({
      ...deepClone(intent),
      id: randomUUID(),
      intentDigest,
      state: 'prepared',
      attemptCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return assertSameIntent(inserted, intentDigest);
  }

  /**
   * Executes only a prepared intent. Any ambiguous transport/provider exception is
   * recorded as unknown. An unknown operation can never be executed again; callers
   * must use reconcile. Concrete executors must cancel their transport at a hard
   * deadline; this layer deliberately does not Promise.race an uncancelled write,
   * because doing so would let the old write outlive its durable executing state.
   */
  async execute(
    operationKey: string,
    executor: (operation: IntegrationProviderOperationRecord) => Promise<Record<string, unknown>>,
    options: IntegrationProviderAttemptOptions = {},
  ): Promise<IntegrationProviderOperationRecord> {
    const current = await this.require(operationKey);
    if (current.state === 'succeeded') return current;
    if (current.state === 'unknown' || current.state === 'executing') throw new ProviderOperationReconcileRequiredError(operationKey, current.state);
    if (current.state !== 'prepared') throw new ProviderOperationTerminalError(operationKey, current.state);
    await options.assertAttemptCurrent?.();
    await this.fences.assertCurrent(current);
    await options.assertAttemptCurrent?.();
    const executing = await this.storage.compareAndSet({
      id: current.id,
      expectedState: 'prepared',
      nextState: 'executing',
      patch: { attemptCount: current.attemptCount + 1, updatedAt: this.now().toISOString() },
      ...(options.mutationFence ? { mutationFence: options.mutationFence } : {}),
    });
    if (!executing) return this.resolveExecuteRace(operationKey);
    try {
      await options.assertAttemptCurrent?.();
      await this.fences.assertCurrent(executing);
    } catch (error) {
      await options.assertAttemptCurrent?.();
      return this.transitionOrReload(executing, 'executing', 'failed', {
        error: errorMessage(error),
        receipt: { outcome: 'not_applied', evidence: 'pre_execution_fence_rejected' },
      }, options.mutationFence);
    }

    let receipt: Record<string, unknown>;
    try {
      await options.assertAttemptCurrent?.();
      receipt = await executor(executing);
    } catch (error) {
      await options.assertAttemptCurrent?.();
      const definitive = options.isDefinitiveFailure?.(error) === true;
      return this.transitionOrReload(executing, 'executing', definitive ? 'failed' : 'unknown', {
        error: errorMessage(error),
        ...(definitive ? { receipt: { outcome: 'not_applied', evidence: 'executor_definitive_failure' } } : {}),
      }, options.mutationFence);
    }

    // If the attempt lost its lease while the provider call was in flight, leave the
    // durable operation executing. The new owner must reconcile the remote fact.
    await options.assertAttemptCurrent?.();
    try {
      await this.fences.assertCurrent(executing);
    } catch (error) {
      await options.assertAttemptCurrent?.();
      return this.transitionOrReload(executing, 'executing', 'unknown', { error: errorMessage(error) }, options.mutationFence);
    }
    await options.assertAttemptCurrent?.();
    return this.transitionOrReload(executing, 'executing', 'succeeded', { receipt }, options.mutationFence);
  }
  /**
   * Reconcile is read-only at the provider. not_found/indeterminate remain unknown;
   * not_applied is a terminal, evidence-backed no-effect result. Any later retry must
   * be a separate durable operation with its own bounded semantic key.
   */
  async reconcile(
    operationKey: string,
    reconciler: (operation: IntegrationProviderOperationRecord) => Promise<IntegrationProviderReconcileResult>,
    options: Pick<IntegrationProviderAttemptOptions, 'assertAttemptCurrent' | 'mutationFence'> = {},
  ): Promise<IntegrationProviderOperationRecord> {
    const current = await this.require(operationKey);
    if (current.state === 'succeeded' || current.state === 'needs_human') return current;
    if (current.state !== 'unknown' && current.state !== 'executing') throw new ProviderOperationTerminalError(operationKey, current.state);
    await options.assertAttemptCurrent?.();
    await this.fences.assertCurrent(current);
    let result: IntegrationProviderReconcileResult;
    try {
      await options.assertAttemptCurrent?.();
      result = await reconciler(current);
    } catch (error) { result = { status: 'indeterminate', detail: errorMessage(error) }; }
    await options.assertAttemptCurrent?.();
    await this.fences.assertCurrent(current);
    await options.assertAttemptCurrent?.();
    if (result.status === 'succeeded') {
      return this.transitionOrReload(current, current.state, 'succeeded', { receipt: result.receipt }, options.mutationFence);
    }
    if (result.status === 'not_applied') {
      const quiescenceAlreadyObserved = current.state === 'unknown'
        && current.receipt?.outcome === 'quiescence_observed';
      if (!quiescenceAlreadyObserved) {
        // Entering unknown because the write timed out is not itself a no-effect observation.
        // Persist one exact observation, then require a later reconcile call before replacement.
        return this.transitionOrReload(current, current.state, 'unknown', {
          error: safeProviderDetail(result.detail),
          receipt: { ...result.evidence, outcome: 'quiescence_observed' },
        }, options.mutationFence);
      }
      return this.transitionOrReload(current, 'unknown', 'failed', {
        error: safeProviderDetail(result.detail),
        receipt: { ...result.evidence, outcome: 'not_applied' },
      }, options.mutationFence);
    }
    if (result.status === 'mismatch') {
      return this.transitionOrReload(current, current.state, 'needs_human', {
        error: safeProviderDetail(result.detail),
        ...(result.evidence ? { receipt: result.evidence } : {}),
      }, options.mutationFence);
    }
    return this.transitionOrReload(current, current.state, 'unknown', {
      error: safeProviderDetail(result.detail ?? 'Provider operation outcome is still unknown'),
    }, options.mutationFence);
  }

  private async require(operationKey: string): Promise<IntegrationProviderOperationRecord> {
    const record = await this.storage.getByOperationKey(operationKey);
    if (!record) throw new ProviderOperationNotFoundError(operationKey);
    return record;
  }

  private async resolveExecuteRace(operationKey: string): Promise<IntegrationProviderOperationRecord> {
    const current = await this.require(operationKey);
    if (current.state === 'succeeded') return current;
    throw new ProviderOperationReconcileRequiredError(operationKey, current.state);
  }

  private async transitionOrReload(
    operation: IntegrationProviderOperationRecord,
    expectedState: IntegrationProviderOperationState,
    nextState: IntegrationProviderOperationState,
    values: { receipt?: Record<string, unknown>; error?: string },
    mutationFence?: IntegrationCandidateMutationFence,
  ): Promise<IntegrationProviderOperationRecord> {
    const updated = await this.storage.compareAndSet({
      id: operation.id,
      expectedState,
      nextState,
      patch: {
        attemptCount: operation.attemptCount,
        updatedAt: this.now().toISOString(),
        ...(values.receipt === undefined ? {} : { receipt: redactDurableJson(values.receipt) }),
        ...(values.error === undefined ? {} : { error: safeProviderDetail(values.error) }),
      },
      ...(mutationFence ? { mutationFence } : {}),
    });
    return updated ?? this.require(operation.operationKey);
  }
}

export function integrationProviderOperationKey(input: {
  repositoryId: string;
  candidateId: string;
  candidateRevision: number;
  kind: IntegrationProviderOperationKind;
  target: string;
}): string {
  for (const [name, value] of Object.entries(input)) if (value === '' || value === undefined || value === null) throw new Error(`Provider operation key ${name} is required`);
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32);
  return `integration:${input.kind}:${input.candidateId}:r${input.candidateRevision}:${digest}`;
}

export function integrationProviderIntentDigest(intent: IntegrationProviderOperationIntent): string {
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

export class ProviderOperationReconcileRequiredError extends Error {
  constructor(readonly operationKey: string, readonly operationState: IntegrationProviderOperationState) { super(`Provider operation ${operationKey} is ${operationState}; reconcile is required`); this.name = 'ProviderOperationReconcileRequiredError'; }
}
export class ProviderOperationTerminalError extends Error {
  constructor(readonly operationKey: string, readonly operationState: IntegrationProviderOperationState) { super(`Provider operation ${operationKey} is terminal: ${operationState}`); this.name = 'ProviderOperationTerminalError'; }
}
export class ProviderOperationNotFoundError extends Error {
  constructor(readonly operationKey: string) { super(`Provider operation ${operationKey} was not prepared`); this.name = 'ProviderOperationNotFoundError'; }
}
export class ProviderOperationKeyCollisionError extends Error {
  constructor(readonly operationKey: string) { super(`Provider operation key ${operationKey} was reused for a different intent`); this.name = 'ProviderOperationKeyCollisionError'; }
}

function validateIntent(intent: IntegrationProviderOperationIntent): void {
  if (!intent.operationKey || !intent.repositoryId || !intent.fence.candidateId || !intent.fence.executionId) throw new Error('Provider operation intent is incomplete');
  if (!Number.isSafeInteger(intent.fence.workflowEpoch) || intent.fence.workflowEpoch < 0 || !Number.isSafeInteger(intent.fence.laneEpoch) || intent.fence.laneEpoch < 0 || !Number.isSafeInteger(intent.fence.candidateRevision) || intent.fence.candidateRevision < 1) throw new Error('Provider operation fence is invalid');
}
function assertSameIntent(record: IntegrationProviderOperationRecord, digest: string): IntegrationProviderOperationRecord { if (record.intentDigest !== digest) throw new ProviderOperationKeyCollisionError(record.operationKey); return record; }
function errorMessage(error: unknown): string {
  return safeProviderDetail(error instanceof Error ? error.message : String(error));
}
function safeProviderDetail(value: string): string {
  return redactDurableSecrets(value.replace(/[\r\n\t]+/g, ' ')).slice(0, 2_000);
}
function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
