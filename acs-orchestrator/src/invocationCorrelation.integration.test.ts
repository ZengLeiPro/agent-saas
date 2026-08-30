import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExecutionAttempt, createInvocationCorrelation } from 'server/runtime/invocationCorrelation.js';
import { serializeRequest } from 'server/runtime/httpTransport.js';
import type { ToolInvocationRequest } from 'server/runtime/handProtocol.js';

import { parseWireRequest as parseHandRequest } from '../../hand-server/src/handlers.js';
import { FileHandInvocationStore } from '../../hand-server/src/invocationStore.js';
import { parseWireRequest as parseAcsRequest } from './protocol.js';

let journalDir: string;

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'correlation-contract-'));
});

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true });
});

describe('Brain → Hand → ACS correlation contract', () => {
  it('keeps logical identity stable across attempts, replay, cancel and restart reconciliation', async () => {
    const logical = createInvocationCorrelation({
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      invocationId: 'run-1:call-1',
      handId: 'hand-1',
    });
    const firstAttempt = createExecutionAttempt(logical);
    const request: ToolInvocationRequest = {
      toolName: 'Shell',
      input: { command: 'true' },
      context: {
        invocationId: logical.invocationId,
        handId: logical.handId,
        correlation: firstAttempt,
        workspace: {
          id: 'workspace-1',
          root: '/brain-only',
          sessionId: 'session-1',
          executionTarget: 'server-remote',
        },
      },
    };

    const wire = serializeRequest(request);
    const hand = parseHandRequest(wire);
    const acs = parseAcsRequest(wire);
    expect(hand).toMatchObject({
      ok: true,
      value: { context: { invocationId: logical.invocationId, correlation: firstAttempt } },
    });
    expect(acs).toMatchObject({
      ok: true,
      value: { context: { invocationId: logical.invocationId, correlation: firstAttempt } },
    });
    if (!acs.ok) throw new Error(acs.error);
    expect({ ...acs.value.context.correlation, sandboxId: 'sandbox-1' }).toMatchObject({
      invocationId: logical.invocationId,
      attemptId: firstAttempt.attemptId,
      sandboxId: 'sandbox-1',
    });

    const store = new FileHandInvocationStore(journalDir);
    const first = await store.registerRunning(logical.invocationId!, firstAttempt.attemptId);
    expect(first.outcome).toBe('created');
    await store.complete(logical.invocationId!, { status: 'success', content: 'done' });

    const retryAttempt = createExecutionAttempt(logical);
    expect(retryAttempt.attemptId).not.toBe(firstAttempt.attemptId);
    const retryWire = serializeRequest({ ...request, context: { ...request.context, correlation: retryAttempt } });
    expect(parseHandRequest(retryWire)).toMatchObject({
      ok: true,
      value: { context: { invocationId: logical.invocationId, correlation: retryAttempt } },
    });
    const replay = await store.registerRunning(logical.invocationId!, retryAttempt.attemptId);
    expect(replay).toMatchObject({
      outcome: 'replay',
      record: {
        invocationId: logical.invocationId,
        executionAttemptId: firstAttempt.attemptId,
        response: { status: 'success', content: 'done' },
      },
    });

    const failedId = 'run-1:call-failed';
    await store.registerRunning(failedId, 'attempt-failed');
    await store.complete(failedId, { status: 'error', error: 'provider failed' });
    expect(await store.registerRunning(failedId, 'attempt-failed-retry')).toMatchObject({
      outcome: 'replay',
      record: { executionAttemptId: 'attempt-failed', response: { status: 'error', error: 'provider failed' } },
    });

    const cancelledId = 'run-1:call-cancelled';
    await store.markCancelled(cancelledId);
    expect(await store.registerRunning(cancelledId, 'attempt-after-cancel')).toMatchObject({
      outcome: 'cancelled_tombstone',
      record: { invocationId: cancelledId },
    });

    const interruptedId = 'run-1:call-disconnected';
    await store.registerRunning(interruptedId, 'attempt-disconnected');
    const restarted = new FileHandInvocationStore(journalDir);
    await restarted.reconcileStartup();
    expect(await restarted.get(interruptedId)).toMatchObject({
      invocationId: interruptedId,
      executionAttemptId: 'attempt-disconnected',
      response: { status: 'error', metadata: { interrupted: true, indeterminate: true } },
    });
  });
});
