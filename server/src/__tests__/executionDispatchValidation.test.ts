import { describe, expect, it } from 'vitest';

import { getTranscriptPath } from '../data/transcripts/store.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import type { RunRecord } from '../runtime/runStore.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import {
  assertDispatchedRun,
  canonicalizeDispatchPayload,
  InvalidTaskboardDispatchPayloadError,
} from '../taskboard/executionDispatchValidation.js';
import type { TaskboardExecutionDispatch } from '../taskboard/types.js';

const AGENT_CWD = '/workspace';
const OWNER_USER_ID = 'kyvynk4r399zsr';
const TENANT_ID = 'kaiyan';
const USERNAME = 'zenglei';
const USER_ROLE = 'admin' as const;
const MODEL = 'ark-agents/glm-5.3';
const EXECUTION_TARGET = 'server-container' as const;

// review 每轮强制新建独立 Session，前缀 taskboard-review-<uuid>（isolate review sessions）
const SESSION_ID = 'taskboard-review-12345678-1234-1234-1234-123456789abc';
const EXECUTION_ID = 'exec-review-1';
const RUN_ID = `taskboard-execution-${EXECUTION_ID}`;

function makeDispatch(): TaskboardExecutionDispatch {
  const workspaceUser = {
    id: OWNER_USER_ID,
    username: USERNAME,
    role: USER_ROLE,
    tenantId: TENANT_ID,
  };
  const expectedCwd = resolveUserCwd(AGENT_CWD, workspaceUser);
  const expectedWorkspaceId = deriveStableWorkspaceId(workspaceUser, SESSION_ID);
  const expectedTranscriptPath = getTranscriptPath(expectedCwd, SESSION_ID, {
    userId: OWNER_USER_ID,
    tenantId: TENANT_ID,
  });
  const now = new Date().toISOString();
  const session = {
    sessionId: SESSION_ID,
    userId: OWNER_USER_ID,
    username: USERNAME,
    userRole: USER_ROLE,
    tenantId: TENANT_ID,
    channel: 'web',
    cwd: expectedCwd,
    transcriptPath: expectedTranscriptPath,
    modelRef: MODEL,
    executionTarget: EXECUTION_TARGET,
    workspaceId: expectedWorkspaceId,
    status: 'running' as const,
    sandboxWorkloadDescriptor: { kind: 'taskboard' as const, taskKind: 'delivery' as const, purpose: 'review' as const },
    createdAt: now,
    updatedAt: now,
  };
  const run = {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    userId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    model: MODEL,
    channel: 'web',
    idempotencyKey: `taskboard-execution:${EXECUTION_ID}`,
    executionTarget: EXECUTION_TARGET,
    workspaceId: expectedWorkspaceId,
    status: 'pending',
    metadata: {
      sandboxWorkloadTopLevel: true,
      sandboxWorkloadDescriptor: session.sandboxWorkloadDescriptor,
    },
  };
  return {
    runId: RUN_ID,
    executionId: EXECUTION_ID,
    outboxExecutionId: EXECUTION_ID,
    taskId: 'task-1',
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    ownerUserId: OWNER_USER_ID,
    payload: { version: 1, session, run },
    attemptCount: 1,
    leaseId: 'lease-1',
  };
}

describe('canonicalizeDispatchPayload（review 独立 Session 首跑重建契约）', () => {
  it('canonical run.metadata 携带 username/userRole/modelRef，满足 wake metadata 重建', () => {
    const dispatch = makeDispatch();
    const canonical = canonicalizeDispatchPayload(dispatch, AGENT_CWD);

    expect(canonical.run.metadata).toMatchObject({
      taskboardExecution: true,
      taskboardExecutionId: EXECUTION_ID,
      taskboardTaskId: 'task-1',
      outputTransactionMode: 'terminal_buffered',
      username: USERNAME,
      userRole: USER_ROLE,
      modelRef: MODEL,
      sandboxWorkloadTopLevel: true,
      sandboxWorkloadDescriptor: { kind: 'taskboard', taskKind: 'delivery', purpose: 'review' },
      cwd: expect.any(String),
      transcriptPath: expect.any(String),
    });
    // runtimeWakeSessionRestore 首跑重建必需的四个字段：cwd / transcriptPath / username / channel
    expect(canonical.run.metadata).toMatchObject({
      cwd: expect.any(String),
      transcriptPath: expect.any(String),
      username: USERNAME,
    });
    expect(canonical.run.channel).toBe('web');
    expect(canonical.session).toMatchObject({
      sessionId: SESSION_ID,
      username: USERNAME,
      userRole: USER_ROLE,
      channel: 'web',
      modelRef: MODEL,
      sessionSource: 'taskboard_execution',
      memoryAutomationEligible: false,
      memoryPolicyVersion: 'v2',
      sandboxWorkloadDescriptor: { kind: 'taskboard', taskKind: 'delivery', purpose: 'review' },
    });
  });

  it('拒绝伪造或不一致的 Taskboard workload', () => {
    const dispatch = makeDispatch();
    dispatch.payload.session.sandboxWorkloadDescriptor = { kind: 'interactive' };
    expect(() => canonicalizeDispatchPayload(dispatch, AGENT_CWD)).toThrow(InvalidTaskboardDispatchPayloadError);

    const mismatched = makeDispatch();
    mismatched.payload.run.metadata = {
      ...mismatched.payload.run.metadata,
      sandboxWorkloadDescriptor: { kind: 'taskboard', taskKind: 'delivery', purpose: 'work' },
    };
    expect(() => canonicalizeDispatchPayload(mismatched, AGENT_CWD)).toThrow(InvalidTaskboardDispatchPayloadError);
  });

  it('assertDispatchedRun 放行一致的首跑 dispatch', () => {
    const dispatch = makeDispatch();
    const canonical = canonicalizeDispatchPayload(dispatch, AGENT_CWD);
    const enqueued: RunRecord = {
      ...canonical.run,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: canonical.run.metadata ?? {},
    };
    expect(() => assertDispatchedRun(enqueued, dispatch, canonical.run)).not.toThrow();
  });

  it('assertDispatchedRun 拒绝 metadata.username 被改写（防止回归）', () => {
    const dispatch = makeDispatch();
    const canonical = canonicalizeDispatchPayload(dispatch, AGENT_CWD);
    const tampered: RunRecord = {
      ...canonical.run,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { ...(canonical.run.metadata ?? {}), username: 'someone-else' },
    };
    expect(() => assertDispatchedRun(tampered, dispatch, canonical.run))
      .toThrow(InvalidTaskboardDispatchPayloadError);
  });
});
