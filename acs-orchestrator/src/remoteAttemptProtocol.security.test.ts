import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRemoteReceipt, type RemoteAttemptFence } from './remoteAttemptProtocol.js';

const fence: RemoteAttemptFence = { protocolVersion: 1, operationId: 'operation-test', attemptId: 'attempt-test',
  ownerId: 'owner-test', sandboxUid: 'sandbox-uid-test', podUid: 'pod-uid-test', startBeforeMs: 1_800_000_000_000 };
const secret = 'a'.repeat(64);
const receipt = { protocolVersion: 1, fence, resource: 'stopped', proof: 'subreaper_no_children', observedAtMs: 1_800_000_000_001 };
function sign(value: unknown, key = secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64');
  return { envelopeVersion: 1, payload, signature: createHmac('sha256', Buffer.from(key, 'hex')).update(payload).digest('hex') };
}
// Extra arguments are allowed at the JavaScript call boundary so this regression
// runs against the original two-argument implementation, not a copied algorithm.
const parse = parseRemoteReceipt as (value: unknown, expected: RemoteAttemptFence, key: string) => ReturnType<typeof parseRemoteReceipt>;

describe('R07 R15 R26 actual remote receipt authentication', () => {
  it('never accepts a hand-written stopped JSON document as termination proof', () => {
    expect(parse(receipt, fence, secret)).toBeNull();
  });
  it('accepts only an authenticated receipt for the exact operation, attempt and Pod', () => {
    expect(parse(sign(receipt), fence, secret)).toEqual(receipt);
    expect(parse(sign(receipt), { ...fence, attemptId: 'replacement' }, secret)).toBeNull();
    expect(parse(sign(receipt), { ...fence, podUid: 'replacement' }, secret)).toBeNull();
    expect(parse(sign(receipt, 'b'.repeat(64)), fence, secret)).toBeNull();
  });
  it('rejects terminal claims with the wrong proof and malformed base64 envelopes', () => {
    expect(parse(sign({ ...receipt, proof: 'local_exit' }), fence, secret)).toBeNull();
    expect(parse(sign({ ...receipt, resource: 'background_owned', proof: 'background_inventory', background: {} }), fence, secret)).toBeNull();
    expect(parse({ ...sign(receipt), payload: 'not base64!' }, fence, secret)).toBeNull();
    expect(parse({ ...sign(receipt), signature: '0' }, fence, secret)).toBeNull();
  });
});
