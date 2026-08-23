import {
  type IntegrationPushCapabilityBinding,
  type IntegrationPushCapabilityHost,
  type IntegrationPushCapabilityHostResult,
  type IntegrationPushCapabilityRecord,
  type IntegrationPushFence,
} from './integrationPushCapability.js';

/**
 * Deterministic in-memory host for tests and single-process adapters. Production hosts
 * should implement the same predicates in one database transaction.
 */
export class InMemoryIntegrationPushCapabilityHost implements IntegrationPushCapabilityHost {
  private readonly records = new Map<string, IntegrationPushCapabilityRecord>();
  private readonly fences = new Map<string, IntegrationPushFence>();

  async issueActive(record: IntegrationPushCapabilityRecord): Promise<IntegrationPushCapabilityHostResult> {
    if (this.records.has(record.id)) return { ok: false, reason: 'already_exists' };
    if (!this.matchesActiveFence(record.binding)) return { ok: false, reason: 'fenced' };
    const stored = clone(record);
    this.records.set(stored.id, stored);
    return { ok: true, record: clone(stored) };
  }

  async findById(id: string): Promise<IntegrationPushCapabilityRecord | undefined> {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  async consumeActive(input: {
    id: string;
    secretHash: string;
    now: string;
    binding: IntegrationPushCapabilityBinding;
  }): Promise<IntegrationPushCapabilityHostResult> {
    const record = this.records.get(input.id);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.secretHash !== input.secretHash) return { ok: false, reason: 'invalid_token' };
    if (record.status === 'consumed') return { ok: false, reason: 'already_consumed' };
    if (record.status === 'revoked') return { ok: false, reason: 'revoked' };
    if (Date.parse(record.expiresAt) <= Date.parse(input.now)) return { ok: false, reason: 'expired' };
    if (!sameBinding(record.binding, input.binding) || !this.matchesActiveFence(record.binding)) {
      return { ok: false, reason: 'fenced' };
    }
    record.status = 'consumed';
    record.consumedAt = input.now;
    return { ok: true, record: clone(record) };
  }

  async revoke(input: { id: string; now: string; reason: string }): Promise<IntegrationPushCapabilityHostResult> {
    const record = this.records.get(input.id);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'consumed') return { ok: false, reason: 'already_consumed' };
    if (record.status === 'revoked') return { ok: false, reason: 'revoked' };
    record.status = 'revoked';
    record.revokedAt = input.now;
    record.revokeReason = input.reason;
    return { ok: true, record: clone(record) };
  }

  async fence(input: { fence: IntegrationPushFence; now: string; reason: string }): Promise<number> {
    const key = fenceKey(input.fence);
    const current = this.fences.get(key);
    if (current && (
      input.fence.laneEpoch < current.laneEpoch
      || input.fence.workflowEpoch < current.workflowEpoch
      || (input.fence.enabled && !current.enabled
        && input.fence.laneEpoch === current.laneEpoch
        && input.fence.workflowEpoch === current.workflowEpoch)
    )) {
      throw new Error('Integration push fence cannot move backwards or re-enable without a new epoch');
    }
    this.fences.set(key, { ...input.fence });
    let revoked = 0;
    for (const record of this.records.values()) {
      if (record.status !== 'active' || fenceKey(record.binding) !== key) continue;
      if (!sameFence(record.binding, input.fence) || !input.fence.enabled) {
        record.status = 'revoked';
        record.revokedAt = input.now;
        record.revokeReason = input.reason;
        revoked += 1;
      }
    }
    return revoked;
  }

  private matchesActiveFence(binding: IntegrationPushCapabilityBinding): boolean {
    const fence = this.fences.get(fenceKey(binding));
    return Boolean(fence?.enabled && sameFence(binding, fence));
  }
}

function fenceKey(value: Pick<IntegrationPushCapabilityBinding, 'tenantId' | 'repositoryId' | 'integrationTaskId'>): string {
  return JSON.stringify([value.tenantId, value.repositoryId, value.integrationTaskId]);
}

function sameFence(binding: IntegrationPushCapabilityBinding, fence: IntegrationPushFence): boolean {
  return binding.candidateId === fence.candidateId
    && binding.revision === fence.revision
    && binding.laneEpoch === fence.laneEpoch
    && binding.workflowEpoch === fence.workflowEpoch;
}

function sameBinding(left: IntegrationPushCapabilityBinding, right: IntegrationPushCapabilityBinding): boolean {
  return left.tenantId === right.tenantId
    && left.repositoryId === right.repositoryId
    && left.integrationTaskId === right.integrationTaskId
    && left.candidateId === right.candidateId
    && left.revision === right.revision
    && left.executionId === right.executionId
    && left.exactRef === right.exactRef
    && left.expectedOldOid === right.expectedOldOid
    && left.expectedBaseOid === right.expectedBaseOid
    && left.laneEpoch === right.laneEpoch
    && left.workflowEpoch === right.workflowEpoch;
}

function clone(record: IntegrationPushCapabilityRecord): IntegrationPushCapabilityRecord {
  return { ...record, binding: { ...record.binding } };
}
