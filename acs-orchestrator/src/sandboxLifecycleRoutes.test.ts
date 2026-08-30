import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SandboxBusyError, type SandboxManager } from './sandboxManager.js';
import {
  handleSandboxLifecycleRoute,
  matchSandboxLifecycleRoute,
} from './sandboxLifecycleRoutes.js';

function request(method: string, url: string, body: unknown, authorized = true): IncomingMessage {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = authorized ? { authorization: 'Bearer test-token' } : {};
  req.end(JSON.stringify(body));
  return req;
}

function response() {
  const replies: Array<{ status: number; body: any }> = [];
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(raw?: string) { replies.push({ status, body: raw ? JSON.parse(raw) : undefined }); return this; },
  } as unknown as ServerResponse;
  return { res, replies };
}

function options(manager: Partial<SandboxManager>) {
  return {
    sandboxManager: manager as SandboxManager,
    authorize: (req: IncomingMessage) => req.headers.authorization === 'Bearer test-token',
    busySandboxNames: () => new Set(['as-busy']),
  };
}

describe('authenticated sandbox lifecycle routes', () => {
  it('matches only the lifecycle update and exact scope delete endpoints', () => {
    expect(matchSandboxLifecycleRoute('/sandboxes/lifecycle')).toBe('update');
    expect(matchSandboxLifecycleRoute('/sandboxes/scope?source=test')).toBe('delete-scope');
    expect(matchSandboxLifecycleRoute('/sandboxes/as-name')).toBeNull();
  });

  it('authenticates and forwards a validated lifecycle update to SandboxManager', async () => {
    const updateLifecycle = vi.fn(async () => ({ name: 'as-task', retentionDeadline: '2026-08-30T00:05:00.000Z' }));
    const unauthorized = response();
    await handleSandboxLifecycleRoute(
      request('POST', '/sandboxes/lifecycle', {}, false),
      unauthorized.res,
      'update',
      options({ updateLifecycle } as Partial<SandboxManager>),
    );
    expect(unauthorized.replies.at(-1)).toMatchObject({ status: 401 });
    expect(updateLifecycle).not.toHaveBeenCalled();

    const reply = response();
    const body = {
      workspaceId: 'ws_kaiyan__u1',
      sessionId: 'session-1',
      sandboxScopeId: 'scope-1',
      terminalState: 'completed',
      terminalAt: '2026-08-30T00:00:00.000Z',
      retentionDeadline: '2026-08-30T00:05:00.000Z',
      outcome: { ok: true },
    };
    await handleSandboxLifecycleRoute(
      request('POST', '/sandboxes/lifecycle', body),
      reply.res,
      'update',
      options({ updateLifecycle } as Partial<SandboxManager>),
    );
    expect(updateLifecycle).toHaveBeenCalledWith(body);
    expect(reply.replies.at(-1)).toMatchObject({
      status: 200,
      body: { status: 'ok', name: 'as-task' },
    });
  });

  it('makes exact scope deletion missing-idempotent and maps busy/protected to 409', async () => {
    const identity = {
      workspaceId: 'ws_kaiyan__u1',
      sessionId: 'session-1',
      sandboxScopeId: 'scope-1',
    };
    const deleteByScope = vi.fn(async () => ({ name: 'as-task', deleted: false, missing: true }));
    const missing = response();
    await handleSandboxLifecycleRoute(
      request('DELETE', '/sandboxes/scope', identity),
      missing.res,
      'delete-scope',
      options({ deleteByScope } as Partial<SandboxManager>),
    );
    expect(deleteByScope).toHaveBeenCalledWith(identity, { busySandboxNames: new Set(['as-busy']) });
    expect(missing.replies.at(-1)).toEqual({
      status: 200,
      body: { status: 'ok', name: 'as-task', deleted: false, missing: true },
    });

    deleteByScope.mockRejectedValueOnce(new SandboxBusyError('protected sandbox'));
    const busy = response();
    await handleSandboxLifecycleRoute(
      request('DELETE', '/sandboxes/scope', identity),
      busy.res,
      'delete-scope',
      options({ deleteByScope } as Partial<SandboxManager>),
    );
    expect(busy.replies.at(-1)).toEqual({
      status: 409,
      body: { status: 'error', error: 'protected sandbox' },
    });
  });
});
