import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceRef } from '../agent/toolRuntime.js';
import {
  HttpTransport,
  serializeRequest,
  toolTimeoutMs,
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
  it('uses the thirty-minute default only for foreground Shell requests', () => {
    expect(toolTimeoutMs(buildRequest({
      toolName: 'Shell',
      input: { command: 'pnpm test' },
    }))).toBe(1_800_000);
    expect(toolTimeoutMs(buildRequest({
      toolName: 'Shell',
      input: { command: 'pnpm test', mode: 'background' },
    }))).toBe(0);
    expect(toolTimeoutMs(buildRequest({
      toolName: 'Shell',
      input: { command: 'pnpm test', timeoutMs: 123 },
    }))).toBe(123);
  });

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
    expect(wire.context.workspace).not.toHaveProperty('workload');
  });

  it('serializes an explicit sandbox resource override and omits it by default', () => {
    expect(serializeRequest(buildRequest()).context.workspace).not.toHaveProperty('sandboxResources');
    const wire = serializeRequest(buildRequest({
      context: {
        workspace: { ...SAMPLE_WORKSPACE, sandboxResources: { cpu: '1', memoryMb: 2048 } },
      },
    }));
    expect(wire.context.workspace.sandboxResources).toEqual({ cpu: '1', memoryMb: 2048 });
  });

  it('passes the mapped ACS workload descriptor and never serializes topLevelSessionId', () => {
    const wire = serializeRequest(buildRequest({
      context: {
        workspace: {
          ...SAMPLE_WORKSPACE,
          topLevelSessionId: 'top-1',
          workload: { class: 'taskboard', taskKind: 'delivery', purpose: 'work' },
        },
      },
    }));
    expect(wire.context.workspace.workload).toEqual({ class: 'taskboard', taskKind: 'delivery', purpose: 'work' });
    expect(wire.context.workspace).not.toHaveProperty('topLevelSessionId');
  });

  it('preserves toolName / input / userId / username / sessionId', () => {
    const wire = serializeRequest(buildRequest());
    expect(wire.toolName).toBe('Write');
    expect(wire.input).toEqual({ path: 'a.txt', content: 'hi' });
    expect(wire.context.workspace.userId).toBe('u-1');
    expect(wire.context.workspace.username).toBe('admin');
    expect(wire.context.workspace.sessionId).toBe('session-abc');
  });

  it('serializes the versioned correlation contract and rejects conflicting legacy ids', () => {
    const wire = serializeRequest(buildRequest({
      context: {
        workspace: SAMPLE_WORKSPACE,
        invocationId: 'run-1:call-1',
        correlation: {
          version: 1,
          sessionId: 'session-abc',
          runId: 'run-1',
          toolCallId: 'call-1',
          invocationId: 'run-1:call-1',
          attemptId: 'attempt-1',
        },
      },
    }));
    expect(wire.context.correlation).toMatchObject({
      version: 1,
      invocationId: 'run-1:call-1',
      attemptId: 'attempt-1',
    });
    const correlationOnly = serializeRequest(buildRequest({
      context: {
        workspace: SAMPLE_WORKSPACE,
        correlation: { version: 1, invocationId: 'correlation-only', attemptId: 'attempt-only' },
      },
    }));
    expect(correlationOnly.context.invocationId).toBe('correlation-only');
    expect(correlationOnly.context.correlation?.attemptId).toBe('attempt-only');
    expect(() => serializeRequest(buildRequest({
      context: {
        workspace: SAMPLE_WORKSPACE,
        invocationId: 'legacy-a',
        correlation: { version: 1, invocationId: 'contract-b' },
      },
    }))).toThrow(/冲突/);
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
    // connectRetryBackoffMs: [] 关闭连接重试，单测持续失败路径不等退避
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl, connectRetryBackoffMs: [] });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toMatch(/ECONNREFUSED/);
  });

  // ── 连接类瞬时失败重试（2026-07-15 零停机部署批次）──────────────

  it('retries connection errors and succeeds once orchestrator is back', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl,
      connectRetryBackoffMs: [5, 5, 5],
    });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('success');
    expect(calls).toBe(3);
  });

  it('retries HTTP 503 (orchestrator draining) honoring retry-after', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'orchestrator draining, retry shortly' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      }
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl,
      connectRetryBackoffMs: [5, 5],
    });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('success');
    expect(calls).toBe(2);
  });

  it('fails fast on structured ACS capacity 503 instead of retrying', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({
        status: 'error', code: 'ACS_CAPACITY_EXHAUSTED', error: 'capacity exhausted',
      }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'retry-after': '30',
          'x-acs-error-code': 'ACS_CAPACITY_EXHAUSTED',
        },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl,
      connectRetryBackoffMs: [5, 5],
    });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toContain('ACS_CAPACITY_EXHAUSTED');
    expect(calls).toBe(1);
  });

  it('exhausts retries and surfaces the original network error', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl,
      connectRetryBackoffMs: [5, 5],
    });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.error : '').toMatch(/ECONNREFUSED/);
    expect(calls).toBe(3); // 初始 + 2 次重试
  });

  it('does not retry 4xx / non-503 5xx responses', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls++; return new Response('boom', { status: 500 }); }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl,
      connectRetryBackoffMs: [5, 5],
    });
    const response = await transport.invoke(buildRequest());
    expect(response.status).toBe('error');
    expect(calls).toBe(1);
  });

  it('stops retrying when the caller aborts during backoff', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl,
      connectRetryBackoffMs: [10_000],
    });
    const promise = transport.invoke(buildRequest({
      context: { workspace: SAMPLE_WORKSPACE, signal: controller.signal },
    }));
    setTimeout(() => controller.abort(), 20);
    const response = await promise;
    expect(response.status).toBe('error');
    expect(response.status === 'error' ? response.metadata?.aborted : undefined).toBe(true);
    expect(calls).toBe(1);
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

  it('injects allowlist wire env from envResolver (AZEROTH_TOKEN + AZEROTH_API_URL)', async () => {
    let captured: string = '';
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = init?.body as string;
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl,
      envResolver: (ws) => {
        expect(ws.username).toBe('admin');
        return {
          AZEROTH_TOKEN: 'pat_admin_test',
          AZEROTH_API_URL: 'https://fc.kaiyan.net/ky-azeroth',
        };
      },
    });
    await transport.invoke(buildRequest());
    const body = JSON.parse(captured) as WireToolInvocationRequest;
    expect(body.context.env).toEqual({
      AZEROTH_TOKEN: 'pat_admin_test',
      AZEROTH_API_URL: 'https://fc.kaiyan.net/ky-azeroth',
    });
  });

  it('forwards standard connector env and strips process-loading keys', async () => {
    let captured: string = '';
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = init?.body as string;
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl,
      envResolver: () => ({ AZEROTH_TOKEN: 'pat_x' }),
    });
    const request = buildRequest();
    request.context.env = {
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      GH_TOKEN: 'ghp-xxx',
      FOO_BAR: 'baz',
      PATH: '/tmp/evil',
      NODE_OPTIONS: '--require /tmp/evil.js',
    };
    await transport.invoke(request);
    const body = JSON.parse(captured) as WireToolInvocationRequest;
    expect(body.context.env).toEqual({
      AZEROTH_TOKEN: 'pat_x',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      GH_TOKEN: 'ghp-xxx',
      FOO_BAR: 'baz',
    });
    expect(body.context.env).not.toHaveProperty('PATH');
    expect(body.context.env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('omits context.env entirely when envResolver returns empty / undefined', async () => {
    let captured: string = '';
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = init?.body as string;
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl,
      envResolver: () => ({}),
    });
    await transport.invoke(buildRequest());
    const body = JSON.parse(captured) as WireToolInvocationRequest;
    expect(body.context).not.toHaveProperty('env');
  });

  it('omits context.env when no envResolver is provided (backward compat)', async () => {
    let captured: string = '';
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = init?.body as string;
      return new Response(JSON.stringify({ status: 'success', content: 'ok' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl,
    });
    await transport.invoke(buildRequest());
    const body = JSON.parse(captured) as WireToolInvocationRequest;
    expect(body.context).not.toHaveProperty('env');
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels the remote invocation when an established stream terminates unexpectedly', async () => {
    const urls: string[] = [];
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith('/execute-stream')) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'progress', message: 'accepted' })}\n\n`));
            controller.error(new Error('terminated'));
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-terminated' },
    }))) seen.push(chunk);

    expect(urls).toContain('http://h/invocations/run-1%3Acall-terminated');
    expect(seen.at(-1)).toMatchObject({
      type: 'completed',
      response: { status: 'error', error: expect.stringContaining('terminated') },
    });
  });

  it('cancels the remote invocation when SSE ends without a completed chunk', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith('/execute-stream')) {
        return new Response(`data: ${JSON.stringify({ type: 'progress', message: 'accepted' })}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ baseUrl: 'http://h', authToken: 'secret-token-12345', fetchImpl });

    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-eof' },
    }))) seen.push(chunk);

    expect(urls).toContain('http://h/invocations/run-1%3Acall-eof');
    expect(seen.at(-1)).toMatchObject({
      type: 'completed',
      response: { status: 'error', error: 'hand-server stream ended without completed chunk' },
    });
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

  it('recovers the remote final result after the transport stream timeout', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      urls.push(target);
      if (target.endsWith('/execute-stream')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (target.endsWith('/invocations/run-1%3Acall-timeout')) {
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({
            status: 'ok',
            invocationId: 'run-1:call-timeout',
            completed: true,
            response: { status: 'error', error: 'Shell timed out after 100ms', metadata: { timedOut: true } },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ status: 'ok', cancelled: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'error', error: 'unexpected URL' }), { status: 500 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl,
      invokeTimeoutMs: 20,
      streamCleanupGraceMs: 0,
      invocationResultPollTimeoutMs: 100,
      invocationResultPollIntervalMs: 1,
    });

    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      input: { command: 'sleep 1', timeoutMs: 1 },
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-timeout' },
    }))) seen.push(chunk);

    expect(seen.at(-1)).toMatchObject({
      type: 'completed',
      response: {
        status: 'error',
        error: 'Shell timed out after 100ms',
        metadata: { timedOut: true, remoteResultRecovered: true },
      },
    });
    expect(urls).toContain('http://h/invocations/run-1%3Acall-timeout');
    expect(urls.filter((url) => url.endsWith('/invocations/run-1%3Acall-timeout'))).toHaveLength(2);
  });

  it('bounds hanging DELETE and GET requests during timeout recovery', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      urls.push(target);
      if (target.endsWith('/execute-stream')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (init?.method === 'GET') {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      baseUrl: 'http://h',
      authToken: 'secret-token-12345',
      fetchImpl,
      invokeTimeoutMs: 10,
      streamCleanupGraceMs: 0,
      invocationResultPollTimeoutMs: 20,
      invocationResultPollIntervalMs: 1,
      invocationResultRequestTimeoutMs: 5,
    });

    const startedAt = Date.now();
    const seen = [];
    for await (const chunk of transport.invokeStream(buildRequest({
      toolName: 'Shell',
      input: { command: 'sleep 1', timeoutMs: 1 },
      context: { workspace: SAMPLE_WORKSPACE, invocationId: 'run-1:call-hanging-control' },
    }))) seen.push(chunk);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(seen.at(-1)).toMatchObject({
      type: 'completed',
      response: { status: 'error', metadata: { timedOut: true } },
    });
    expect(urls).toContain('http://h/invocations/run-1%3Acall-hanging-control');
    expect(urls.filter((url) => url.endsWith('/invocations/run-1%3Acall-hanging-control')).length).toBeGreaterThanOrEqual(2);
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
