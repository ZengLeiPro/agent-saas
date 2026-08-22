import { describe, expect, it } from 'vitest';

import {
  IntegrationPushCapabilityError,
  IntegrationPushCapabilityService,
  MAX_INTEGRATION_PUSH_CAPABILITY_TTL_MS,
  type IntegrationPushCapabilityBinding,
  type IntegrationPushRequest,
} from './integrationPushCapability.js';
import { InMemoryIntegrationPushCapabilityHost } from './integrationPushCapabilityMemoryHost.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const binding: IntegrationPushCapabilityBinding = {
  tenantId: 'tenant-1',
  repositoryId: 'github:org/repo',
  integrationTaskId: 'integration-task-1',
  candidateId: 'candidate-1',
  revision: 4,
  executionId: 'execution-1',
  exactRef: 'refs/heads/integration/task-1',
  expectedOldOid: A,
  expectedBaseOid: C,
  laneEpoch: 7,
  workflowEpoch: 11,
};

const request: IntegrationPushRequest = {
  ref: binding.exactRef,
  oldOid: A,
  newOid: B,
  parentOid: A,
  isFastForward: true,
  operation: 'update',
  laneEpoch: 7,
  workflowEpoch: 11,
};

async function setup() {
  let nowMs = Date.parse('2026-08-19T04:30:00.000Z');
  const host = new InMemoryIntegrationPushCapabilityHost();
  const service = new IntegrationPushCapabilityService(host, () => new Date(nowMs));
  await service.fence({
    tenantId: binding.tenantId,
    repositoryId: binding.repositoryId,
    integrationTaskId: binding.integrationTaskId,
    candidateId: binding.candidateId,
    revision: binding.revision,
    laneEpoch: binding.laneEpoch,
    workflowEpoch: binding.workflowEpoch,
    enabled: true,
  }, 'activate candidate');
  return { host, service, advance(ms: number) { nowMs += ms; } };
}

async function expectCode(action: Promise<unknown>, code: IntegrationPushCapabilityError['code']) {
  await expect(action).rejects.toMatchObject({ code });
}

describe('IntegrationPushCapabilityService', () => {
  it('issues an opaque short-TTL token while persisting only its digest and full binding', async () => {
    const { host, service } = await setup();
    const issued = await service.issue({ binding, ttlMs: 30_000 });
    expect(issued.token).toMatch(/^ipc1\.[^.]+\.[A-Za-z0-9_-]{43}$/);
    const stored = await host.findById(issued.capabilityId);
    expect(stored?.binding).toEqual(binding);
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(JSON.stringify(stored)).not.toContain(issued.token.split('.')[2]);
  });

  it('rejects excessive and non-positive TTLs', async () => {
    const { service } = await setup();
    await expectCode(service.issue({ binding, ttlMs: MAX_INTEGRATION_PUSH_CAPABILITY_TTL_MS + 1 }), 'ttl_out_of_range');
    await expectCode(service.issue({ binding, ttlMs: 0 }), 'ttl_out_of_range');
  });

  it.each([
    ['main', 'refs/heads/main'],
    ['tag', 'refs/tags/v1.0.0'],
    ['another branch', 'refs/heads/feature/steal'],
    ['lookalike traversal', 'refs/heads/integration/../main'],
  ])('rejects %s at issuance', async (_name, exactRef) => {
    const { service } = await setup();
    await expectCode(service.issue({ binding: { ...binding, exactRef } }), 'invalid_ref');
  });

  it('allows exactly one fast-forward update to the bound ref and old OID', async () => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    const consumed = await service.consume(token, request);
    expect(consumed.status).toBe('consumed');
    await expectCode(service.consume(token, request), 'already_consumed');
  });

  it('allows one exact rebase update onto the bound immutable base', async () => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    const consumed = await service.consume(token, {
      ...request,
      parentOid: binding.expectedBaseOid,
      isFastForward: false,
    });
    expect(consumed.status).toBe('consumed');
  });

  it('atomically admits only one of two concurrent consumers', async () => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    const results = await Promise.allSettled([
      service.consume(token, request),
      service.consume(token, request),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it.each([
    ['main', { ref: 'refs/heads/main' }, 'invalid_ref'],
    ['tag', { ref: 'refs/tags/v1' }, 'invalid_ref'],
    ['other integration branch', { ref: 'refs/heads/integration/other' }, 'ref_mismatch'],
    ['delete operation', { operation: 'delete', newOid: '0'.repeat(40) }, 'delete_forbidden'],
    ['zero new OID disguised as update', { newOid: '0'.repeat(40) }, 'delete_forbidden'],
    ['ref creation', { operation: 'create', oldOid: '0'.repeat(40) }, 'create_forbidden'],
    ['force push without rebase parent', { isFastForward: false }, 'force_push_forbidden'],
    ['rebase parent disguised as fast-forward', { parentOid: C, isFastForward: true }, 'force_push_forbidden'],
    ['unbound parent', { parentOid: 'd'.repeat(40), isFastForward: false }, 'parent_oid_mismatch'],
    ['stale old OID', { oldOid: 'd'.repeat(40) }, 'old_oid_mismatch'],
    ['stale lane epoch', { laneEpoch: 6 }, 'epoch_mismatch'],
    ['stale workflow epoch', { workflowEpoch: 10 }, 'epoch_mismatch'],
  ] as const)('rejects attack: %s', async (_name, patch, code) => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    await expectCode(service.consume(token, { ...request, ...patch } as IntegrationPushRequest), code);
    expect((await service.verify(token)).status).toBe('active');
  });

  it('rejects expiration at the exact boundary', async () => {
    const { service, advance } = await setup();
    const { token } = await service.issue({ binding, ttlMs: 1_000 });
    advance(1_000);
    await expectCode(service.verify(token), 'expired');
    await expectCode(service.consume(token, request), 'expired');
  });

  it('revokes a capability and never includes bearer material in errors', async () => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    await service.revoke(token, 'execution cancelled');
    try {
      await service.consume(token, request);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationPushCapabilityError);
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(token.split('.')[2]);
      expect(error).toMatchObject({ code: 'revoked' });
    }
  });

  it('fences active capabilities immediately when lane/workflow epochs advance', async () => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    const revoked = await service.fence({
      tenantId: binding.tenantId,
      repositoryId: binding.repositoryId,
      integrationTaskId: binding.integrationTaskId,
      candidateId: binding.candidateId,
      revision: binding.revision,
      laneEpoch: binding.laneEpoch + 1,
      workflowEpoch: binding.workflowEpoch,
      enabled: true,
    }, 'lane reacquired');
    expect(revoked).toBe(1);
    await expectCode(service.consume(token, request), 'revoked');
    await expectCode(service.issue({ binding }), 'fenced');
  });

  it('fences the prior revision when the authoritative candidate changes', async () => {
    const { service } = await setup();
    const { token } = await service.issue({ binding });
    const revoked = await service.fence({
      tenantId: binding.tenantId,
      repositoryId: binding.repositoryId,
      integrationTaskId: binding.integrationTaskId,
      candidateId: 'candidate-2',
      revision: binding.revision + 1,
      laneEpoch: binding.laneEpoch + 1,
      workflowEpoch: binding.workflowEpoch,
      enabled: true,
    }, 'candidate revised');
    expect(revoked).toBe(1);
    await expectCode(service.consume(token, request), 'revoked');
  });

  it('fails closed when a candidate is disabled and requires a new epoch to re-enable', async () => {
    const { service } = await setup();
    await service.fence({
      tenantId: binding.tenantId,
      repositoryId: binding.repositoryId,
      integrationTaskId: binding.integrationTaskId,
      candidateId: binding.candidateId,
      revision: binding.revision,
      laneEpoch: binding.laneEpoch,
      workflowEpoch: binding.workflowEpoch,
      enabled: false,
    }, 'cancelled');
    await expectCode(service.issue({ binding }), 'fenced');
    await expect(service.fence({
      tenantId: binding.tenantId,
      repositoryId: binding.repositoryId,
      integrationTaskId: binding.integrationTaskId,
      candidateId: binding.candidateId,
      revision: binding.revision,
      laneEpoch: binding.laneEpoch,
      workflowEpoch: binding.workflowEpoch,
      enabled: true,
    }, 'unsafe resume')).rejects.toThrow(/new epoch/);
  });

  it('rejects malformed or forged tokens without exposing them or allowing revocation DoS', async () => {
    const { service } = await setup();
    await expectCode(service.verify('not-a-capability'), 'malformed_token');
    const { token } = await service.issue({ binding });
    const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await expectCode(service.verify(forged), 'invalid_token');
    await expectCode(service.revoke(forged, 'attacker request'), 'invalid_token');
    expect((await service.verify(token)).status).toBe('active');
  });
});
