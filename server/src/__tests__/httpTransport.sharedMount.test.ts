import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceRef } from '../agent/toolRuntime.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { ToolInvocationRequest } from '../runtime/handProtocol.js';

const workspace: WorkspaceRef = {
  id: 'session-abc',
  root: '/host/path',
  userId: 'u-1',
  username: 'admin',
  sessionId: 'session-abc',
  sandboxScopeId: 'scope-1',
  mountSubPath: 'workspaces/kaiyan/u-1',
  executionTarget: 'server-remote',
};
const request = (): ToolInvocationRequest => ({
  toolName: 'Write',
  input: { path: 'a.txt' },
  context: { workspace: { ...workspace, sharedReadOnlySubPath: 'org-agents/a/shared' } },
});

describe('HttpTransport shared read-only mount capability', () => {
  it('fails closed before execution when the capability is absent', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok', capabilities: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret', fetchImpl });
    await expect(transport.invoke(request())).resolves.toMatchObject({
      status: 'error',
      metadata: { reasonCode: 'ACS_SHARED_READ_ONLY_MOUNT_UNAVAILABLE' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('http://h/health');
  });

  it('executes only after ACS proves the capability', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/health')
        ? new Response(
            JSON.stringify({
              status: 'ok',
              capabilities: {
                sharedReadOnlyMount: { available: true, protocolVersion: 1 },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    ) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret', fetchImpl });
    await expect(transport.invoke(request())).resolves.toMatchObject({
      status: 'success',
      content: 'ok',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
