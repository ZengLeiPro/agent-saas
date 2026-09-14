import { describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import { queryRemoteAttemptEvidence } from './remoteAttemptClient.js';
import type { RemoteAttemptFence } from './remoteAttemptProtocol.js';

const fence: RemoteAttemptFence = {
  protocolVersion: 1,
  operationId: 'c0a28140-5ed4-414c-9e22-bb8a2e818660',
  attemptId: 'attempt-1',
  ownerId: 'owner-1',
  sandboxUid: '3dfd6a8d-bb8b-44cc-991d-4a5bed486d91',
  podUid: 'b1fb7965-e305-45f0-b035-269248211265',
  startBeforeMs: 1_789_404_849_702,
};

describe('queryRemoteAttemptEvidence', () => {
  it('passes the fence Pod UID to attempt_control.py so Downward API `uid` cannot fail the RPC', async () => {
    const run = vi.fn(async () => ({ stdout: '{}', stderr: '', exitCode: 1, signal: null }));
    await queryRemoteAttemptEvidence({
      config: {
        authToken: 'test-token',
        sandboxContainerName: 'sandbox',
        workspaceMountPath: '/workspace',
      } as AcsOrchestratorConfig,
      kubectl: { run } as unknown as Kubectl,
      sandboxName: 'as-one',
      fence,
      action: 'status',
    });
    expect(run).toHaveBeenCalledOnce();
    const args = run.mock.calls[0]?.[0] as string[];
    expect(args).toContain('/app/acs-orchestrator/dist/remote/attempt_control.py');
    expect(args).toContain(`--owned-pod-uid=${fence.podUid}`);
    expect(args.at(-1)).toBe(`--owned-pod-uid=${fence.podUid}`);
  });

  it('omits the flag when the fence Pod UID is the unusable Downward API literal', async () => {
    const run = vi.fn(async () => ({ stdout: '{}', stderr: '', exitCode: 1, signal: null }));
    await queryRemoteAttemptEvidence({
      config: {
        authToken: 'test-token',
        sandboxContainerName: 'sandbox',
        workspaceMountPath: '/workspace',
      } as AcsOrchestratorConfig,
      kubectl: { run } as unknown as Kubectl,
      sandboxName: 'as-one',
      fence: { ...fence, podUid: 'uid' },
      action: 'status',
    });
    const args = run.mock.calls[0]?.[0] as string[];
    expect(args.join(' ')).not.toContain('--owned-pod-uid=');
  });
});
