import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OrgAgentWorkAttempt, OrgAgentWorkOrder } from '../../data/orgGroupAgents/index.js';
import {
  buildOrgAgentContinuation,
  verifyOrgAgentContinuationArtifacts,
} from './orgAgentContinuation.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function attempt(patch: Partial<OrgAgentWorkAttempt>): OrgAgentWorkAttempt {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'work-1',
    tenantId: 'tenant-1',
    attemptNo: 1,
    status: 'failed',
    publishState: 'none',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  } as OrgAgentWorkAttempt;
}

describe('orgAgentContinuation', () => {
  it('拒绝取消且不可续接的 attempt 与无上下文 attempt', () => {
    expect(() =>
      buildOrgAgentContinuation({
        work: { workOrderId: 'work-1' } as OrgAgentWorkOrder,
        attempt: attempt({ status: 'cancelled' }),
        allowPendingArtifacts: false,
      }),
    ).toThrow('ORG_AGENT_CONTINUATION_SOURCE_CANCELLED');

    expect(() =>
      buildOrgAgentContinuation({
        work: { workOrderId: 'work-1' } as OrgAgentWorkOrder,
        attempt: attempt({ status: 'failed' }),
        allowPendingArtifacts: false,
      }),
    ).toThrow('ORG_AGENT_CONTINUATION_CONTEXT_MISSING');
  });

  it('已发布产物不可读时 fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-missing-published-'));
    roots.push(root);
    await expect(
      verifyOrgAgentContinuationArtifacts({
        work: { workOrderId: 'work-1' } as OrgAgentWorkOrder,
        attempt: attempt({
          status: 'completed',
          publishState: 'published',
          artifactManifest: {
            version: 1,
            files: [{ path: '已撤销.md', digest: `sha256:${'a'.repeat(64)}`, size: 1 }],
            totalBytes: 1,
            capturedAt: new Date().toISOString(),
            publishedRoot: 'published/work-1/attempt-1',
          },
        }),
        sharedRoot: root,
      }),
    ).rejects.toThrow('ORG_AGENT_CONTINUATION_PUBLISHED_ARTIFACT_UNAVAILABLE');
  });
});
