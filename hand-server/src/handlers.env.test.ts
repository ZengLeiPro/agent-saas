import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type { ToolInvocationRequest } from 'server/runtime/handProtocol.js';
import { handleExecute, type HandlerDeps } from './handlers.js';

class FakeResponse {
  statusCode = 0;
  body = '';
  writeHead(statusCode: number): void { this.statusCode = statusCode; }
  end(chunk?: string): void { this.body += chunk ?? ''; }
}

describe('hand execute env forwarding', () => {
  it('forwards filtered wire.context.env into provider ToolInvocationRequest', async () => {
    const captured: ToolInvocationRequest[] = [];
    const body = JSON.stringify({
      toolName: 'Shell',
      input: { command: 'git status' },
      context: {
        workspace: { id: 'ws-1', username: 'alice' },
        env: {
          GH_TOKEN: 'github_pat_test',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          NODE_OPTIONS: '--inspect',
        },
      },
    });
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
    Object.defineProperties(request, {
      method: { value: 'POST' },
      headers: { value: { authorization: 'Bearer test-token' } },
      socket: { value: { remoteAddress: '127.0.0.1' } },
    });
    const response = new FakeResponse();
    const deps = {
      workspaceResolver: { resolveAndEnsure: vi.fn(async () => '/workspace/ws-1') },
      provider: {
        execute: vi.fn(async (toolRequest: ToolInvocationRequest) => {
          captured.push(toolRequest);
          return { status: 'success', output: 'ok' };
        }),
      },
      internalExecutionTarget: 'server-local',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { authToken: 'test-token' },
    } as unknown as HandlerDeps;

    await handleExecute(request, response as unknown as ServerResponse, deps);

    expect(response.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.context.env).toEqual({
      GH_TOKEN: 'github_pat_test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    });
  });
});
