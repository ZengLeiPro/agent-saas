import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKyAppDeliveryRouter } from './delivery.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function rig() {
  const plan = {
    reason: '合同到期',
    disableInstallation: true,
    revokeCredentials: true,
    exportOwner: '客户管理员',
    externalActions: ['撤销 DNS'],
  };
  const delivery = {
    installationId: 'iid-1',
    tenantId: 'tenant-a',
    systemId: 'demo',
    offboardingStatus: 'planned',
    offboardingPlan: plan,
  };
  const planOffboarding = vi.fn(async (input: { status: string; plan: unknown }) => ({
    ...delivery,
    offboardingStatus: input.status,
    offboardingPlan: input.plan,
  }));
  const setStatus = vi.fn().mockResolvedValue({ status: 'disabled' });
  const revoke = vi.fn().mockResolvedValue(undefined);
  const append = vi.fn().mockResolvedValue({ auditId: 'audit-1' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: 'platform-1',
      username: 'root',
      tenantId: 'pantheon',
      role: 'admin',
    };
    next();
  });
  app.use(
    '/api/app-contract/v1',
    createKyAppDeliveryRouter({
      store: {
        getDelivery: vi.fn().mockResolvedValue(delivery),
        planOffboarding,
      } as never,
      systems: {
        getInstallation: vi.fn().mockResolvedValue({
          installationId: 'iid-1',
          tenantId: 'tenant-a',
          systemId: 'demo',
          status: 'enabled',
        }),
      } as never,
      installations: { setStatus } as never,
      credentials: {
        listMetadata: vi.fn().mockResolvedValue([
          { credentialId: 'cred-active', status: 'active' },
          { credentialId: 'cred-old', status: 'revoked' },
        ]),
        revoke,
      } as never,
      audit: { append } as never,
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口不可用');
  const request = (body: unknown) =>
    fetch(
      `http://127.0.0.1:${address.port}/api/app-contract/v1/installations/iid-1/offboarding/execute-platform`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  return { request, planOffboarding, setStatus, revoke, append };
}

describe('KY App 离场执行', () => {
  it('二次确认后按顺序停用实例、吊销有效凭据并记录终态', async () => {
    const test = await rig();
    const response = await test.request({
      confirmInstallationId: 'iid-1',
      exportCompleted: true,
      externalActionsCompleted: true,
    });
    expect(response.status).toBe(200);
    expect(test.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 'iid-1', status: 'disabled' }),
    );
    expect(test.revoke).toHaveBeenCalledOnce();
    expect(test.revoke).toHaveBeenCalledWith('cred-active', 'iid-1');
    expect(test.planOffboarding.mock.calls.map(([input]) => input.status)).toEqual([
      'running',
      'completed',
    ]);
    expect(test.append).toHaveBeenCalledTimes(2);
  });

  it('未确认数据导出或外部动作时不执行任何平台变更', async () => {
    const test = await rig();
    const response = await test.request({
      confirmInstallationId: 'iid-1',
      exportCompleted: false,
      externalActionsCompleted: true,
    });
    expect(response.status).toBe(400);
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.revoke).not.toHaveBeenCalled();
    expect(test.planOffboarding).not.toHaveBeenCalled();
  });
});
