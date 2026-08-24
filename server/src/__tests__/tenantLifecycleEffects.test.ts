import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { applyTenantLifecycleChange, TenantLifecycleWatcher } from '../app/tenantLifecycleEffects.js';
import { WebChannel } from '../channels/web/channel.js';
import { TenantStore } from '../data/tenants/store.js';
import type { UserStore } from '../data/users/store.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';

const JWT_SECRET = 'tenant-lifecycle-websocket-secret';

describe('tenant lifecycle effects', () => {
  const channels: WebChannel[] = [];
  const servers: Server[] = [];
  const clients: WebSocket[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const client of clients) {
      if (client.readyState !== WebSocket.CLOSED) client.terminate();
    }
    await Promise.all(channels.map(channel => channel.stop()));
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
    clients.length = 0;
    channels.length = 0;
    servers.length = 0;
    dirs.length = 0;
  });

  async function startChannel(tenantStore: TenantStore, userStore: UserStore): Promise<{ channel: WebChannel; port: number }> {
    const channel = new WebChannel({
      executionConfig: createExecutionConfig(),
      tenantStore,
      userStore,
      jwtSecret: JWT_SECRET,
    }, async function* () { yield { type: 'done' as const }; });
    channels.push(channel);
    const app = express();
    await channel.start(app);
    const server = createServer(app);
    servers.push(server);
    channel.attachToServer(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
    return { channel, port };
  }

  async function connectClient(port: number, userId: string): Promise<WebSocket> {
    const token = jwt.sign({ sub: userId, username: userId, role: 'user', tenantId: 'acme' }, JWT_SECRET);
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => client.send(JSON.stringify({ action: 'auth', token })));
      client.once('error', reject);
      client.on('message', function onAuth(raw) {
        const envelope = JSON.parse(raw.toString()) as { data?: { type?: string } };
        if (envelope.data?.type !== 'auth_ok') return;
        client.off('message', onAuth);
        resolve();
      });
    });
    return client;
  }

  function waitForClose(client: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise(resolve => {
      client.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf-8') }));
    });
  }

  it('两个 WebChannel 实例从共享状态断开真实 WS 并取消运行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-lifecycle-effects-'));
    dirs.push(root);
    const storePath = join(root, 'tenants.json');
    const writer = new TenantStore(storePath);
    await writer.create({ id: 'acme', name: 'Acme', createdBy: 'system' });
    await writer.create({ id: 'backup', name: 'Backup', createdBy: 'system' });
    const firstStore = new TenantStore(storePath);
    const secondStore = new TenantStore(storePath);
    const userStore = {
      findById: (id: string) => ({ id, username: id, role: 'user', tenantId: 'acme' }),
      listAll: () => [],
    } as unknown as UserStore;
    const [first, second] = await Promise.all([
      startChannel(firstStore, userStore),
      startChannel(secondStore, userStore),
    ]);
    const [firstClient, secondClient] = await Promise.all([
      connectClient(first.port, 'acme-user-1'),
      connectClient(second.port, 'acme-user-2'),
    ]);
    const firstClientClosed = waitForClose(firstClient);
    const secondClientClosed = waitForClose(secondClient);
    const firstController = new AbortController();
    const secondController = new AbortController();
    (first.channel as any).activeStreams.set('multi-1', {
      controller: firstController, userId: 'acme-user-1', ws: firstClient, runId: 'multi-run-1',
    });
    (second.channel as any).activeStreams.set('multi-2', {
      controller: secondController, userId: 'acme-user-2', ws: secondClient, runId: 'multi-run-2',
    });
    const abortFirst = vi.fn().mockReturnValue(1);
    const abortSecond = vi.fn().mockReturnValue(1);
    const cancelFirst = vi.fn().mockResolvedValue(2);
    const cancelSecond = vi.fn().mockResolvedValue(0);
    const firstWatcher = new TenantLifecycleWatcher({
      tenantStore: firstStore,
      intervalMs: 60_000,
      onChange: change => applyTenantLifecycleChange(change, {
        tenantStore: firstStore,
        webChannel: first.channel,
        abortTenant: abortFirst,
        runStore: { cancelActiveByTenant: cancelFirst },
      }).then(() => undefined),
    });
    const secondWatcher = new TenantLifecycleWatcher({
      tenantStore: secondStore,
      intervalMs: 60_000,
      onChange: change => applyTenantLifecycleChange(change, {
        tenantStore: secondStore,
        webChannel: second.channel,
        abortTenant: abortSecond,
        runStore: { cancelActiveByTenant: cancelSecond },
      }).then(() => undefined),
    });
    firstWatcher.start();
    secondWatcher.start();
    try {
      await writer.setDisabled('acme', true, 'platform-1');
      await Promise.all([firstWatcher.pollNow(), secondWatcher.pollNow()]);
      expect(firstController.signal.aborted).toBe(true);
      expect(secondController.signal.aborted).toBe(true);
      expect(abortFirst).toHaveBeenCalledWith('acme', 'Tenant disabled: shared tenant state changed');
      expect(abortSecond).toHaveBeenCalledWith('acme', 'Tenant disabled: shared tenant state changed');
      expect(cancelFirst).toHaveBeenCalledWith('acme', 'Tenant disabled: shared tenant state changed');
      expect(cancelSecond).toHaveBeenCalledWith('acme', 'Tenant disabled: shared tenant state changed');
      await expect(firstClientClosed).resolves.toEqual({ code: 4003, reason: 'Tenant disabled' });
      await expect(secondClientClosed).resolves.toEqual({ code: 4003, reason: 'Tenant disabled' });

      await writer.setDisabled('acme', false, 'platform-1');
      await Promise.all([firstWatcher.pollNow(), secondWatcher.pollNow()]);
      const fencedFirst = new AbortController();
      const fencedSecond = new AbortController();
      (first.channel as any).activeStreams.set('multi-fence-1', {
        controller: fencedFirst, userId: 'acme-user-1', ws: firstClient, runId: 'multi-fence-run-1',
      });
      (second.channel as any).activeStreams.set('multi-fence-2', {
        controller: fencedSecond, userId: 'acme-user-2', ws: secondClient, runId: 'multi-fence-run-2',
      });
      abortFirst.mockClear();
      abortSecond.mockClear();
      cancelFirst.mockClear();
      cancelSecond.mockClear();

      await writer.setDisabled('acme', true, 'platform-1');
      await writer.setDisabled('acme', false, 'platform-1');
      await Promise.all([firstWatcher.pollNow(), secondWatcher.pollNow()]);
      expect(fencedFirst.signal.aborted).toBe(true);
      expect(fencedSecond.signal.aborted).toBe(true);
      expect(abortFirst).toHaveBeenCalledWith('acme', 'Tenant disabled: missed tenant suspension fence');
      expect(abortSecond).toHaveBeenCalledWith('acme', 'Tenant disabled: missed tenant suspension fence');

      const staleEventStream = new AbortController();
      (first.channel as any).activeStreams.set('multi-stale', {
        controller: staleEventStream, userId: 'acme-user-1', ws: firstClient, runId: 'multi-stale-run',
      });
      await applyTenantLifecycleChange({
        tenantId: 'acme',
        disabled: true,
        actorUserId: 'platform-1',
        reason: 'delayed old suspend event',
        updatedAt: '2026-08-15T00:00:00.000Z',
      }, { tenantStore: firstStore, webChannel: first.channel, abortTenant: abortFirst });
      expect(staleEventStream.signal.aborted).toBe(false);

      const raceStore = new TenantStore(storePath);
      const raceController = new AbortController();
      (first.channel as any).activeStreams.set('multi-race', {
        controller: raceController, userId: 'acme-user-1', ws: firstClient, runId: 'multi-race-run',
      });
      const abortRace = vi.fn().mockReturnValue(1);
      let resumeBeforeEffect = true;
      const raceWatcher = new TenantLifecycleWatcher({
        tenantStore: raceStore,
        intervalMs: 60_000,
        onChange: async change => {
          if (change.disabled && resumeBeforeEffect) {
            resumeBeforeEffect = false;
            await writer.setDisabled('acme', false, 'platform-1');
          }
          await applyTenantLifecycleChange(change, {
            tenantStore: raceStore,
            webChannel: first.channel,
            abortTenant: abortRace,
          });
        },
      });
      raceWatcher.start();
      try {
        await writer.setDisabled('acme', true, 'platform-1');
        await raceWatcher.pollNow();
        expect(raceController.signal.aborted).toBe(false);
        await raceWatcher.pollNow();
        expect(raceController.signal.aborted).toBe(true);
        expect(abortRace).toHaveBeenCalledWith('acme', 'Tenant disabled: missed tenant suspension fence');
      } finally {
        raceWatcher.stop();
      }
    } finally {
      firstWatcher.stop();
      secondWatcher.stop();
    }
  });
});
