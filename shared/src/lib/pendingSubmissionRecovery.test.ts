import { describe, expect, it } from 'vitest';
import {
  authoritativeQueueOnly,
  recoverDurablePending,
  settlePendingAck,
  type DurablePendingSubmission,
} from './pendingSubmissionRecovery';

const pending = (overrides: Partial<DurablePendingSubmission> = {}): DurablePendingSubmission => ({
  version: 1,
  clientMsgId: 'client-1',
  sessionId: 'session-1',
  appProtocolVersion: 50,
  schemaVersion: 5,
  authGeneration: 9,
  createdAt: 100,
  status: 'pending_verification',
  draft: '保留的草稿',
  attachments: [{ displayName: 'evidence.pdf', attachmentId: 'attachment-1' }],
  ...overrides,
});

describe('M50-05 kill/upgrade pending recovery', () => {
  it('queries authoritative ACK after same-version kill/restore and never auto-replays', () => {
    const decision = recoverDurablePending(pending(), { appProtocolVersion: 50, schemaVersion: 5, authGeneration: 9 });
    expect(decision).toMatchObject({ action: 'query_server_ack', autoReplay: false });
    if (decision.action !== 'query_server_ack') throw new Error('unexpected');
    expect(decision.requestId).toContain('client-1');
    expect(settlePendingAck(decision.pending, { clientMsgId: 'client-1', accepted: true }).status).toBe('acknowledged');
    expect(settlePendingAck(decision.pending, null)).toMatchObject({
      status: 'failed_unconfirmed', draft: '保留的草稿', attachments: [{ displayName: 'evidence.pdf' }],
    });
  });

  it.each([
    { appProtocolVersion: 51, schemaVersion: 5, authGeneration: 9 },
    { appProtocolVersion: 50, schemaVersion: 6, authGeneration: 9 },
  ])('marks old pending failed_upgrade on app/schema upgrade and preserves composer data', (current) => {
    const decision = recoverDurablePending(pending(), current);
    expect(decision).toMatchObject({ action: 'mark_failed_upgrade', autoReplay: false });
    if (decision.action !== 'mark_failed_upgrade') throw new Error('unexpected');
    expect(decision.pending).toMatchObject({ status: 'failed_upgrade', draft: '保留的草稿' });
    expect(decision.pending.failureMessage).toContain('重新发送');
  });

  it('drops cross-auth-generation pending rather than querying or replaying it', () => {
    expect(recoverDurablePending(pending(), { appProtocolVersion: 50, schemaVersion: 5, authGeneration: 10 }))
      .toEqual({ action: 'discard_identity_mismatch', clientMsgId: 'client-1', autoReplay: false });
  });

  it('restores queued messages only from the server snapshot', () => {
    const server = [{ clientMsgId: 'server-authoritative' }];
    expect(authoritativeQueueOnly(server)).toEqual(server);
    expect(authoritativeQueueOnly(server)).not.toBe(server);
  });
});
