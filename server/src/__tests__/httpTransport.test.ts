import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceRef } from '../agent/toolRuntime.js';
import {
  HttpTransport,
  serializeRequest,
  type WireToolInvocationRequest,
} from '../runtime/httpTransport.js';
import type { ToolInvocationRequest, ToolInvocationResponse } from '../runtime/handProtocol.js';

const SAMPLE_WORKSPACE: WorkspaceRef = {
  id: 'session-abc',
  root: '/Users/admin/secret-host-path',
  userId: 'u-1',
  username: 'admin',
  sessionId: 'session-abc',
  sandboxScopeId: 'ws_kaiyan__u-1',
  mountSubPath: 'workspaces/kaiyan/u-1',
  executionTarget: 'server-remote',
};

function buildRequest(extra: Partial<ToolInvocationRequest> = {}): ToolInvocationRequest {
  return {
    toolName: 'Write',
    input: { path: 'a.txt', content: 'hi' },
    context: { workspace: SAMPLE_WORKSPACE },
    ...extra,
  };
}

function mockOk(body: ToolInvocationResponse): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('HttpTransport.serializeRequest', () => {
  it('drops brain-local workspace.root and AbortSignal', () => {
    const request = buildRequest({
      context: { workspace: SAMPLE_WORKSPACE, signal: new AbortController().signal },
    });
    const wire = serializeRequest(request);
    expect(wire.context.workspace).not.toHaveProperty('root');
    expect((wire as unknown as Record<string, unknown>).signal).toBeUndefined();
    expect(wire.context.workspace.id).toBe('session-abc');
    expect(wire.context.workspace.sandboxScopeId).toBe('ws_kaiyan__u-1');
    expect(wire.context.workspace.mountSubPath).toBe('workspaces/kaiyan/u-1');
    expect(wire.context.workspace.executionTarget).toBe('server-remote');
  });

  it('preserves toolName / input / userId / username / sessionId', () => {
    const wire = serializeRequest(buildRequest());
    expect(wire.toolName).toBe('Write');
    expect(wire.input).toEqual({ path: 'a.txt', content: 'hi' });
    expect(wire.context.workspace.userId).toBe('u-1');
    expect(wire.context.workspace.username).toBe('admin');
    expect(wire.context.workspace.sessionId).toBe('session-abc');
  });

  it('preserves durable handId when present', () => {
    const wire = serializeRequest(buildRequest({
      context: {
        workspace: SAMPLE_WORKSPACE,
        invocationId: 'run-1:call-1',
        handId: 'session-abc:agent-saas-acs',
      },
    }));
    expect(wire.context.invocationId).toBe('run-1:call-1');
    expect(wire.context.handId).toBe('session-abc:agent-saas-acs');
  });
});

describe('HttpTransport.invoke', () => {
  it('POSTs to ${baseUrl}/execute with Bearer token and JSON body', async () => {
    let captured: { url?: string | URL; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const transport = new HttpTransport({
      baseUrl: 'http://127.0.0.1:3300/',
      authToken: 'secret-token-12345',
      fetchImpl,
    });
    const response = await transport.invoke(buildRequest());

    expect(response.status).toBe('success');
    expect(captured.url).toBe('http://127.0.0.1:3300/execute');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token-12345');
    expect(headers['content-type']).toBe('application/json');

    const bodyParsed = JSON.parse(captured.init?.body as string) as WireToolInvocationRequest;
    expect(bodyParsed.toolName).toBe('Write');
    expect(bodyParsed.context.workspace).not.toHaveProperty('root');
  });

  it('returns success response body verbatim', async () => {
    const expected: ToolInvocationResponse = {
      status: 'success',
      content: 'wrote a.txt (2 chars)',
      audit: [{
        provider: 'server-container',
        operation: 'writeFile',
        status: 'success',
      }],
      metadata: { path: 'a.txt', bytesWritten: 2 },
    };
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl: mockOk(expected),
    });
    const response = await transport.invoke(buildRequest());
    expect(response).toEqual(expected);
  });

  it('maps 401 to status=error with auth message', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 401 })) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toMatch(/鉴权失败/);
  });

  it('maps non-2xx to status=error with body excerpt', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toMatch(/HTTP 500/);
  });

  it('maps fetch network error to status=error', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toMatch(/ECONNREFUSED/);
  });

  it('honors upstream abort and reports aborted metadata', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;

    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });
    const promise = transport.invoke(buildRequest({
      context: { workspace: SAMPLE_WORKSPACE, signal: controller.signal },
    }));
    controller.abort();
    const response = await promise;
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.metadata?.aborted : undefined).toBe(true);
  });



  it('sends DELETE /invocations/:id when non-streaming invoke is aborted', async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).endsWith('/execute')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          controller.abort();
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const response = await transport.invoke(buildRequest({
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-write', signal: controller.signal },
    }));

    expect(response.status).toBe('error');
    expect(urls).toContain('http://h/invocations/run-1%3Acall-write');
  });

  it('honors invokeTimeoutMs and reports timedOut metadata', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      invokeTimeoutMs: 50,
      fetchImpl,
    });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.metadata?.timedOut : undefined).toBe(true);
  });

  it('rejects malformed response body with status=error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ wrong: 'shape' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toMatch(/不是合法 ToolInvocationResponse/);
  });
});


describe('HttpTransport hand lifecycle helpers', () => {
  it('checks /health and normalizes ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', backend: 'local' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h/', authToken: 'secret-token-12345', fetchImpl });

    await expect(transport.health()).resolves.toEqual({
      status: 'ok',
      metadata: { status: 'ok', backend: 'local' },
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://h/health');
  });



  it('provisions /provision with Bearer auth and workspace recipe', async () => {
    let captured: { url?: string | URL; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ status: 'ok', workspaceId: 'session-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    await expect(transport.provision({ workspaceId: 'session-abc', sandboxScopeId: 'ws_kaiyan__u-1', setupCommands: ['true'] })).resolves.toEqual({
      status: 'ok',
      metadata: { status: 'ok', workspaceId: 'session-abc' },
    });
    expect(captured.url).toBe('http://h/provision');
    expect(captured.init?.method).toBe('POST');
    expect((captured.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token-12345');
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      workspaceId: 'session-abc',
      recipe: { workspaceId: 'session-abc', sandboxScopeId: 'ws_kaiyan__u-1', setupCommands: ['true'] },
    });
  });

  it('discovers /tools but keeps local descriptor schemas as source of truth', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      tools: [{ name: 'Read' }, { name: 'not_registered_remote_only' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const tools = await transport.discoverTools();
    expect(tools.map((tool) => tool.name)).toEqual(['Read']);
    expect(fetchImpl).toHaveBeenCalledWith('http://h/tools');
  });
});

describe('HttpTransport.invokeStream', () => {
  it('posts to /execute-stream, preserves invocationId, and yields SSE chunks', async () => {
    const chunks = [
      { type: 'progress', message: 'accepted' },
      { type: 'completed', response: { status: 'success', content: 'done' } },
    ];
    let captured: { url?: string | URL; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured = { url, init };
      const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-1' },
    }))) seen.push(chunk);

    expect(captured.url).toBe('http://h/execute-stream');
    expect(JSON.parse(captured.init?.body as string).context.invocationId).toBe('run-1:call-1');
    expect(seen).toEqual(chunks);
  });



  it('parses a final SSE frame without a trailing blank line', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `data: ${JSON.stringify({ type: 'completed', response: { status: 'success', content: 'tail' } })}`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-tail' },
    }))) seen.push(chunk);

    expect(seen).toEqual([{ type: 'completed', response: { status: 'success', content: 'tail' } }]);
  });

  it('sends DELETE /invocations/:id when upstream aborts a streaming invocation', async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).endsWith('/execute-stream')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          controller.abort();
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-2', signal: controller.signal },
    }))) seen.push(chunk);

    expect(urls).toContain('http://h/invocations/run-1%3Acall-2');
    expect(seen.at(-1)).toMatchObject({ type: 'completed', response: { status: 'error' } });
  });
});
