import { describe, expect, it } from 'vitest';

import {
  createIntegrationAdmissionReceipt,
  digestCanonical,
  verifyIntegrationAdmissionReceipt,
  type IntegrationAdmissionBinding,
} from './integrationAdmission.js';

const binding: IntegrationAdmissionBinding = {
  candidateId: 'candidate-1',
  candidateRevision: 7,
  reviewExecutionId: 'review-1',
  headOid: 'head-1',
  baseOid: 'base-1',
  treeOid: 'tree-1',
  subjectDigest: 'subject-1',
  workflowEpoch: 11,
  laneEpoch: 3,
  policyRevision: 'policy-2',
  policyDigest: 'policy-digest',
  sourceSetDigest: 'source-set-digest',
};

describe('Integration Admission receipt', () => {
  it('canonicalizes object keys and binds every admission epoch', () => {
    expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
    const receipt = createIntegrationAdmissionReceipt(binding, '2026-08-26T10:00:00.000Z');
    expect(verifyIntegrationAdmissionReceipt(receipt, binding)).toMatchObject({
      ok: true,
      receipt,
    });
  });

  it.each([
    ['candidateRevision', 8],
    ['headOid', 'head-2'],
    ['sourceSetDigest', 'new-source-set'],
    ['policyDigest', 'new-policy'],
    ['laneEpoch', 4],
    ['workflowEpoch', 12],
  ] as const)('revokes approval when %s drifts', (key, value) => {
    const receipt = createIntegrationAdmissionReceipt(binding, '2026-08-26T10:00:00.000Z');
    expect(verifyIntegrationAdmissionReceipt(receipt, { ...binding, [key]: value })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('drifted'),
    });
  });

  it('rejects a tampered receipt', () => {
    const receipt = createIntegrationAdmissionReceipt(binding, '2026-08-26T10:00:00.000Z');
    expect(verifyIntegrationAdmissionReceipt({ ...receipt, headOid: 'tampered' }, binding)).toEqual(
      { ok: false, reason: 'approval receipt digest is invalid' },
    );
  });
});
