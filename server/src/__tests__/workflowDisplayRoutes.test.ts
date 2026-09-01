import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JwtPayload } from '../auth/types.js';
import { WorkflowDisplayPolicyStore } from '../data/workflowDisplay/index.js';
import { createScenariosRouter } from '../routes/scenarios.js';

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('workflow display routes', () => {
  let directory = '';
  let server: Server | null = null;
  let baseUrl = '';
  let currentUser: JwtPayload;
  let policyStore: WorkflowDisplayPolicyStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'workflow-display-routes-'));
    policyStore = new WorkflowDisplayPolicyStore(join(directory, 'policies.json'));
    currentUser = { sub: 'admin-a', username: 'admin-a', role: 'admin', tenantId: 'tenant-a' };
    const users = [
      {
        id: 'admin-a',
        username: 'admin-a',
        realName: '管理员',
        role: 'admin',
        tenantId: 'tenant-a',
        position: '管理层',
        createdAt: '',
        createdBy: '',
        updatedAt: '',
      },
      {
        id: 'user-a',
        username: 'alice',
        realName: '爱丽丝',
        role: 'user',
        tenantId: 'tenant-a',
        position: '销售',
        createdAt: '',
        createdBy: '',
        updatedAt: '',
      },
      {
        id: 'user-b',
        username: 'bob',
        realName: '鲍勃',
        role: 'user',
        tenantId: 'tenant-b',
        position: '销售',
        createdAt: '',
        createdBy: '',
        updatedAt: '',
      },
    ];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { ...currentUser };
      next();
    });
    app.use(
      '/api/scenarios',
      createScenariosRouter({
        workflowDisplayPolicyStore: policyStore,
        userStore: {
          listAll: () => users as never,
          findById: (id: string) => users.find((user) => user.id === id) as never,
        },
        tenantStore: {
          getSettings: () => undefined,
          findById: (id: string) =>
            ['tenant-a', 'tenant-b'].includes(id)
              ? ({ id, name: id === 'tenant-a' ? '组织 A' : '组织 B' } as never)
              : undefined,
        },
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    await rm(directory, { recursive: true, force: true });
  });

  it('组织管理员保存本组织策略，成员读取到服务端解析结果', async () => {
    const catalogResponse = await fetch(`${baseUrl}/api/scenarios/v3`);
    const catalog = (await catalogResponse.json()) as { scenarios: Array<{ id: string }> };
    const workflowIds = catalog.scenarios.slice(0, 2).map((item) => item.id);
    const saved = await fetch(`${baseUrl}/api/scenarios/display-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'tenant',
        displayCount: 2,
        workflowIds,
        expectedRevision: 0,
      }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      tenantId: 'tenant-a',
      scope: 'tenant',
      subjectId: 'tenant-a',
      workflowIds,
      revision: 1,
    });

    currentUser = { sub: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' };
    const effective = await fetch(`${baseUrl}/api/scenarios/display-config`);
    expect(effective.status).toBe(200);
    await expect(effective.json()).resolves.toEqual({
      source: 'tenant',
      displayCount: 2,
      workflowIds,
      revision: 1,
    });
  });

  it('岗位目录只统计当前组织，普通成员不能读取管理配置', async () => {
    const response = await fetch(`${baseUrl}/api/scenarios/display-policies`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenantId: 'tenant-a',
      positions: expect.arrayContaining([{ id: '销售', label: '销售', memberCount: 1 }]),
      members: expect.arrayContaining([
        expect.objectContaining({ id: 'user-a', displayName: '爱丽丝' }),
      ]),
    });
    const body = (await (await fetch(`${baseUrl}/api/scenarios/display-policies`)).json()) as {
      members: Array<{ id: string }>;
    };
    expect(body.members.some((member) => member.id === 'user-b')).toBe(false);

    currentUser = { sub: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' };
    expect((await fetch(`${baseUrl}/api/scenarios/display-policies`)).status).toBe(403);
  });

  it('已配置但暂时无成员的岗位仍可见，便于管理员恢复继承', async () => {
    await policyStore.upsert({
      tenantId: 'tenant-a',
      scope: 'position',
      subjectId: '已撤岗位',
      subjectLabel: '已撤岗位',
      displayCount: 0,
      workflowIds: [],
      expectedRevision: 0,
      actorId: 'admin-a',
    });

    const response = await fetch(`${baseUrl}/api/scenarios/display-policies`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      positions: expect.arrayContaining([{ id: '已撤岗位', label: '已撤岗位', memberCount: 0 }]),
    });
  });

  it('组织管理员传入其他 tenantId 时仍强制写入自己的组织', async () => {
    const catalog = (await (await fetch(`${baseUrl}/api/scenarios/v3`)).json()) as {
      scenarios: Array<{ id: string }>;
    };
    const response = await fetch(`${baseUrl}/api/scenarios/display-policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant-b',
        scope: 'tenant',
        displayCount: 1,
        workflowIds: [catalog.scenarios[0]!.id],
        expectedRevision: 0,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenantId: 'tenant-a',
      subjectId: 'tenant-a',
    });
  });
});
