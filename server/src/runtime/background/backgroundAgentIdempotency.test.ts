import { describe, expect, it } from 'vitest';

import type { RunRecord } from '../runStore.js';
import { isBackgroundAgentIdempotentReplay } from './backgroundAgentIdempotency.js';

const request = {
  description: '后台调研',
  prompt: '完整执行任务',
  agentType: 'general' as const,
  includeCompanyInfo: false,
};
const input = {
  parentRunId: 'parent-run',
  parentSessionId: 'parent-session',
  toolCallId: 'tool-1',
  taskSessionId: 'task-session',
  tenantId: 'tenant-a',
  model: 'model-a',
  request,
};
const task = {
  runId: 'task-1',
  sessionId: 'task-session',
  tenantId: 'tenant-a',
  model: 'model-a',
  status: 'pending',
  requestedAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  metadata: {
    backgroundTask: true,
    backgroundTaskType: 'agent',
    parentRunId: 'parent-run',
    parentSessionId: 'parent-session',
    parentToolCallId: 'tool-1',
    description: request.description,
    prompt: request.prompt,
    agentType: request.agentType,
    modelRef: 'models/model-a',
    includeCompanyInfo: false,
    cwd: '/task',
    workspaceId: 'workspace',
    parentChannel: 'web',
    parentOutputTransactionMode: 'terminal_buffered',
  },
} as RunRecord;

describe('background Agent idempotency identity', () => {
  it('accepts an exact durable replay and rejects changed payloads', () => {
    expect(isBackgroundAgentIdempotentReplay(task, input)).toBe(true);
    expect(
      isBackgroundAgentIdempotentReplay(task, {
        ...input,
        request: { ...request, prompt: '篡改后的任务' },
      }),
    ).toBe(false);
  });
});
