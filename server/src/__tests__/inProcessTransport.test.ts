import { describe, expect, it, vi } from 'vitest';

import type { ExecutionProvider } from '../agent/toolRuntime.js';
import { InProcessTransport } from '../runtime/inProcessTransport.js';
import type { ToolInvocationRequest } from '../runtime/handProtocol.js';

describe('InProcessTransport', () => {
  it('does not dispatch requests that were aborted before invocation', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, content: 'executed' }));
    const provider: ExecutionProvider = {
      execute,
      listInternalTools: () => [],
    };
    const transport = new InProcessTransport(provider);
    const controller = new AbortController();
    controller.abort();
    const request: ToolInvocationRequest = {
      toolName: 'Write',
      input: {},
      context: {
        signal: controller.signal,
        workspace: { id: 'w', root: '/tmp', executionTarget: 'server-local' },
      },
    };

    await expect(transport.invoke(request)).resolves.toMatchObject({
      status: 'error', metadata: { aborted: true },
    });
    const chunks = [];
    for await (const chunk of transport.invokeStream(request)) chunks.push(chunk);
    expect(chunks).toEqual([{
      type: 'completed',
      response: expect.objectContaining({ status: 'error', metadata: { aborted: true } }),
    }]);
    expect(execute).not.toHaveBeenCalled();
  });
});
