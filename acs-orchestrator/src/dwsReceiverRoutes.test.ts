import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AcsExecutor } from './executor.js';
import { handleDwsReceiverRoute } from './dwsReceiverRoutes.js';

const body = {
  protocolVersion: 1,
  action: 'status',
  owner: {
    tenantId: 'tenant-one',
    accountId: 'account-one',
    receiverId: 'drx-fixture',
    ownerId: 'owner-one',
    epoch: '1',
    revision: 3,
    expiresAtMs: Date.now() + 60_000,
  },
  source: {
    accountId: 'account-one',
    receiverId: 'drx-fixture',
    profileId: 'corp:user',
    identityUpdatedAt: '2026-09-10T00:00:00.000Z',
    eventKinds: ['at_me'],
  },
  workspace: {
    id: 'workspace-one',
    sessionId: 'session-one',
    sandboxScopeId: 'scope-one',
    mountSubPath: 'fixtures/dws',
  },
};

function request(method: string, url: string, value?: unknown, authorized = true): IncomingMessage {
  const instance = new PassThrough() as PassThrough & IncomingMessage;
  instance.method = method;
  instance.url = url;
  instance.headers = authorized ? { authorization: 'Bearer fixture' } : {};
  instance.end(value === undefined ? undefined : JSON.stringify(value));
  return instance;
}

function response() {
  let status = 0;
  let finish!: (value: { status: number; body: any; headers: Record<string, string> }) => void;
  const completed = new Promise<{ status: number; body: any; headers: Record<string, string> }>(
    (resolve) => {
      finish = resolve;
    },
  );
  let headers: Record<string, string> = {};
  const rawResponse = {
    writableEnded: false,
    writeHead(code: number, values: Record<string, string>) {
      status = code;
      headers = values;
      return this;
    },
    end(raw?: string) {
      rawResponse.writableEnded = true;
      finish({ status, body: raw ? JSON.parse(raw) : undefined, headers });
      return this;
    },
  };
  const res = rawResponse as unknown as ServerResponse;
  return { res, completed };
}

function dependencies(
  execute = vi.fn(async () => ({
    status: 'success' as const,
    content: JSON.stringify({
      protocolVersion: 1,
      accountId: 'account-one',
      receiverId: 'drx-fixture',
      podUid: 'pod-one',
      ownerEpoch: '1',
      state: 'running',
      highestSequence: 0,
      acknowledgedSequence: 0,
      sourceReady: true,
      sourceAlive: true,
      upstreamReplay: 'unverified',
      needsReconciliation: false,
    }),
  })),
  draining = false,
) {
  return {
    config: { releaseIdentity: { sourceSha: 'a'.repeat(40) } } as any,
    executor: { execute } as unknown as Pick<AcsExecutor, 'execute'>,
    authorize: (candidate: IncomingMessage) => candidate.headers.authorization === 'Bearer fixture',
    draining: () => draining,
    run: async <T>(work: () => Promise<T>) => await work(),
  };
}

describe('DWS durable receiver HTTP routes', () => {
  it('authenticates the bounded capability endpoint', async () => {
    const denied = response();
    expect(
      handleDwsReceiverRoute(
        request('GET', '/dws-receivers/capabilities', undefined, false),
        denied.res,
        dependencies(),
      ),
    ).toBe(true);
    expect(await denied.completed).toMatchObject({ status: 401, body: { code: 'unauthorized' } });

    const accepted = response();
    handleDwsReceiverRoute(
      request('GET', '/dws-receivers/capabilities'),
      accepted.res,
      dependencies(),
    );
    expect(await accepted.completed).toMatchObject({
      status: 200,
      body: {
        protocolVersion: 1,
        ownershipReaders: 1,
        durableReceiver: 1,
        minimumRollbackProtocol: 1,
      },
    });
  });

  it('routes a validated short control call through the owned executor', async () => {
    const execute = vi.fn(async () => ({
      status: 'success' as const,
      content: JSON.stringify({ ok: true }),
    }));
    const reply = response();
    handleDwsReceiverRoute(
      request('POST', '/dws-receivers/control', body),
      reply.res,
      dependencies(execute),
    );
    expect(await reply.completed).toEqual({
      status: 200,
      body: { ok: true },
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: '__DwsReceiver',
        input: body,
        context: expect.objectContaining({
          workspace: expect.objectContaining({ workload: { class: 'cron' } }),
        }),
      }),
    );
  });

  it('blocks only new source starts during deployment drain', async () => {
    const execute = vi.fn();
    const start = response();
    handleDwsReceiverRoute(
      request('POST', '/dws-receivers/control', { ...body, action: 'start' }),
      start.res,
      dependencies(execute, true),
    );
    expect(await start.completed).toMatchObject({
      status: 503,
      body: { code: 'orchestrator_draining' },
      headers: { 'retry-after': '2' },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
