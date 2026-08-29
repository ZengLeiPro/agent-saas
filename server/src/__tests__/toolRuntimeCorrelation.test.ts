import { describe, expect, it, vi } from 'vitest';

import {
  PlatformToolRuntime,
  WORKSPACE_HAND_TOOLS,
  type WorkspaceRef,
} from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { ExecutionTransport } from '../runtime/executionTransport.js';
import type { ToolInvocationResponse } from '../runtime/handProtocol.js';

function successResponse(content: string): ToolInvocationResponse {
  return { status: 'success', content };
}

const workspace: WorkspaceRef = {
  root: '/tmp/project',
  userId: 'admin-1',
  username: 'admin',
  sessionId: 'session-1',
  executionTarget: 'server-local',
};

describe('PlatformToolRuntime correlation routing', () => {
  it('uses streaming transport when invocation identity is provided only by correlation', async () => {
    const invoke = vi.fn(async () => successResponse('non-stream'));
    const invokeStream = vi.fn((_request: Parameters<NonNullable<ExecutionTransport['invokeStream']>>[0]) => (async function* () {
      yield { type: 'output' as const, channel: 'stdout' as const, content: 'streamed' };
      yield { type: 'completed' as const, response: successResponse('done') };
    })());
    const executionTransport: ExecutionTransport = {
      invoke,
      invokeStream,
      listInternalTools: () => WORKSPACE_HAND_TOOLS,
    };
    const runtime = new PlatformToolRuntime({ executionTransport });
    const onStreamChunk = vi.fn();

    const result = await runtime.invoke({
      toolId: 'Shell', input: { command: 'pwd' },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      channelContext: {
        channel: 'web',
        user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
      },
      workspace,
      correlation: { version: 1, invocationId: 'inv-correlation', attemptId: 'attempt-1' },
      onStreamChunk,
    });

    expect(result.content).toBe('done');
    expect(invokeStream).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(onStreamChunk).toHaveBeenCalledWith({ type: 'output', channel: 'stdout', content: 'streamed' });
  });
});
