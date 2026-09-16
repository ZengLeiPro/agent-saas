import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import {
  ExternalClientAuthenticator,
  InMemoryExternalClientStore,
  type ExternalClientView,
} from '../data/externalClients/index.js';
import { TenantStore } from '../data/tenants/store.js';
import { UserStore } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import { createExternalAgentClientsAdminRouter } from '../routes/externalAgentClients.js';

interface Rig {
  server: Server;
  baseUrl: string;
  root: string;
  store: InMemoryExternalClientStore;
  userStore: UserStore;
  tenantStore: TenantStore;
  users: {
    adminA: UserInfo;
    serviceA: UserInfo;
    adminB: UserInfo;
    serviceB: UserInfo;
  };
}

interface KeyResponse {
  apiKey: string;
  client: ExternalClientView;
}

let rig: Rig;

function principal(user: UserInfo): JwtPayload {
  return { sub: user.id, username: user.username, role: user.role, tenantId: user.tenantId };
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'external-agent-clients-'));
  const tenantStore = new TenantStore(join(root, 'tenants.json'));
  await tenantStore.create({ id: 'tenant-a', name: '客户 A', createdBy: 'system' });
  await tenantStore.create({ id: 'tenant-b', name: '客户 B', createdBy: 'system' });
  const userStore = new UserStore(join(root, 'users.json'));
  const adminA = await userStore.create({
    username: 'admin-a',
    password: 'password123',
    role: 'admin',
    tenantId: 'tenant-a',
    createdBy: 'system',
  });
  const serviceA = await userStore.create({
    username: 'external-service-a',
    password: 'password123',
    role: 'user',
    tenantId: 'tenant-a',
    createdBy: adminA.id,
  });
  const adminB = await userStore.create({
    username: 'admin-b',
    password: 'password123',
    role: 'admin',
    tenantId: 'tenant-b',
    createdBy: 'system',
  });
  const serviceB = await userStore.create({
    username: 'external-service-b',
    password: 'password123',
    role: 'user',
    tenantId: 'tenant-b',
    createdBy: adminB.id,
  });
  const users = { adminA, serviceA, adminB, serviceB };
  const store = new InMemoryExternalClientStore();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const caller = Object.values(users).find((user) => user.username === req.header('x-test-user'));
    if (caller) req.user = principal(caller);
    next();
  });
  app.use(
    '/api/admin/external-agent-clients',
    createExternalAgentClientsAdminRouter({
      store,
      userStore,
      tenantStore,
      orgAgentStore: {
        get: (id: string) =>
          id === 'oa-1' ? { id, tenantId: 'tenant-a', enabled: true } : undefined,
      } as never,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/admin/external-agent-clients`,
    root,
    store,
    userStore,
    tenantStore,
    users,
  };
}

async function post(path: string, caller: UserInfo, body?: unknown): Promise<Response> {
  return fetch(`${rig.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': caller.username },
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(async () => {
  rig = await createRig();
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    rig.server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(rig.root, { recursive: true, force: true });
});

describe('External Agent API Client P0', () => {
  it('创建时只展示一次明文 Key，并固定解析到本组织专用账号', async () => {
    const response = await post('', rig.users.adminA, {
      tenantId: 'tenant-b',
      serviceAccountUserId: rig.users.serviceA.id,
      name: 'ERP 集成',
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as KeyResponse;
    expect(created.apiKey).toMatch(/^ky_ext_/);
    expect(created.client).toMatchObject({
      tenantId: 'tenant-a',
      serviceAccountUserId: rig.users.serviceA.id,
      status: 'active',
      effectiveStatus: 'active',
    });
    expect(created.client).not.toHaveProperty('keyHash');

    const auth = new ExternalClientAuthenticator({
      store: rig.store,
      userStore: rig.userStore,
      tenantStore: rig.tenantStore,
    });
    await expect(auth.authenticateBearer(`Bearer ${created.apiKey}`)).resolves.toMatchObject({
      ok: true,
      principal: {
        tenantId: 'tenant-a',
        serviceAccountUserId: rig.users.serviceA.id,
        username: rig.users.serviceA.username,
      },
    });

    const listResponse = await fetch(rig.baseUrl, {
      headers: { 'x-test-user': rig.users.adminA.username },
    });
    const listed = (await listResponse.json()) as { clients: ExternalClientView[] };
    expect(listed.clients).toHaveLength(1);
    expect(listed.clients[0]).not.toHaveProperty('keyHash');
    expect(listed.clients[0]).not.toHaveProperty('apiKey');
  });

  it('轮换立即作废旧 Key，撤销立即作废新 Key', async () => {
    const createResponse = await post('', rig.users.adminA, {
      serviceAccountUserId: rig.users.serviceA.id,
      name: '客服集成',
    });
    const created = (await createResponse.json()) as KeyResponse;
    const auth = new ExternalClientAuthenticator({
      store: rig.store,
      userStore: rig.userStore,
      tenantStore: rig.tenantStore,
    });

    const rotateResponse = await post(`/${created.client.clientId}/rotate-key`, rig.users.adminA);
    expect(rotateResponse.status).toBe(200);
    const rotated = (await rotateResponse.json()) as KeyResponse;
    expect(rotated.apiKey).not.toBe(created.apiKey);
    await expect(auth.authenticateBearer(`Bearer ${created.apiKey}`)).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: 'invalid_api_key',
    });
    await expect(auth.authenticateBearer(`Bearer ${rotated.apiKey}`)).resolves.toMatchObject({
      ok: true,
    });

    const revokeResponse = await post(`/${created.client.clientId}/revoke`, rig.users.adminA);
    expect(revokeResponse.status).toBe(200);
    await expect(auth.authenticateBearer(`Bearer ${rotated.apiKey}`)).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: 'invalid_api_key',
    });
  });

  it('跨租户管理按不存在处理，且账号停用后 Key 立即拒绝', async () => {
    const createResponse = await post('', rig.users.adminA, {
      serviceAccountUserId: rig.users.serviceA.id,
      name: '数据分析集成',
    });
    const created = (await createResponse.json()) as KeyResponse;
    const crossTenant = await post(`/${created.client.clientId}/revoke`, rig.users.adminB);
    expect(crossTenant.status).toBe(404);

    await rig.userStore.setDisabled(rig.users.serviceA.id, true, rig.users.adminA.id);
    const auth = new ExternalClientAuthenticator({
      store: rig.store,
      userStore: rig.userStore,
      tenantStore: rig.tenantStore,
    });
    await expect(auth.authenticateBearer(`Bearer ${created.apiKey}`)).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: 'account_disabled',
    });
  });

  it('拒绝绑定其他租户账号或管理员账号', async () => {
    const otherTenant = await post('', rig.users.adminA, {
      serviceAccountUserId: rig.users.serviceB.id,
      name: '越权集成',
    });
    expect(otherTenant.status).toBe(404);

    const adminAccount = await post('', rig.users.adminA, {
      serviceAccountUserId: rig.users.adminA.id,
      name: '管理员集成',
    });
    expect(adminAccount.status).toBe(409);
    await expect(adminAccount.json()).resolves.toMatchObject({ code: 'invalid_service_account' });
  });

  it('只允许绑定同租户已启用的组织 Agent', async () => {
    const created = await post('', rig.users.adminA, {
      serviceAccountUserId: rig.users.serviceA.id,
      name: '组织专家集成',
      allowedAgentIds: ['oa-1'],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as KeyResponse;
    expect(body.client.allowedAgentIds).toEqual(['oa-1']);

    const denied = await fetch(`${rig.baseUrl}/${body.client.clientId}/agents`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': rig.users.adminA.username },
      body: JSON.stringify({ agentIds: ['oa-other'] }),
    });
    expect(denied.status).toBe(404);
  });
});
