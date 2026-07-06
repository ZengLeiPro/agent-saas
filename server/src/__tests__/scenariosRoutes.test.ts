import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScenariosRouter } from '../routes/scenarios.js';
import type { CronJob, CronJobCreate } from '../cron/types.js';
import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';

const TEST_USER = {
  sub: 'user-1',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
} as const;

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 构造与生产一致的路由挂载：注入普通登录用户，挂到 /api/scenarios */
async function startServer(
  dataPath?: string,
  cronService?: {
    add(create: CronJobCreate, context?: { owner?: string; ownerName?: string }): Promise<CronJob>;
    runNow(id: string): Promise<{ ran: boolean; error?: string }>;
  },
  options: { firstDayGuideBarEnabled?: boolean } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { ...TEST_USER };
    next();
  });
  app.use('/api/scenarios', createScenariosRouter({
    ...(dataPath ? { dataPath } : {}),
    ...(cronService ? { cronService: cronService as never } : {}),
    roleKit: {
      v2Enabled: true,
      firstDayGuideBar: { enabled: true },
      libraryVersion: 'v2',
    },
    tenantStore: {
      getSettings: () => ({
        ...DEFAULT_TENANT_SETTINGS,
        personalization: {
          firstDayGuideBarEnabled: options.firstDayGuideBarEnabled === true,
        },
      }),
    },
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** 测试夹具：两个岗位（sort 故意乱序）+ 三条场景（启用带 source / 未启用 / 缺 enabled 字段） */
const FIXTURE = {
  version: 2,
  updatedAt: '2026-07-03',
  roles: [
    { id: 'sales', name: '销售', sort: 2, roleWelcomeMessage: '销售欢迎语' },
    { id: 'boss', name: '老板/总经理', sort: 1, roleWelcomeMessage: '老板欢迎语' },
  ],
  scenarios: [
    {
      id: 'boss-competitor-daily',
      title: '竞品动态晨报',
      role: 'boss',
      industries: ['all'],
      mode: 'recurring',
      pitch: '每天早上 8 点，一条消息看完同行动态',
      story: '你告诉 AI 盯哪几家 → 它每天检索 → 每早推简报',
      promptTemplate: '帮我盯着这几家同行：{{competitors}}。',
      slots: [{ key: 'competitors', label: '同行公司名单', example: '同行A、同行B' }],
      requires: ['web', 'dingtalk'],
      recommendCron: true,
      signalAdaptation: {
        dailyEmptyStreakToWeekly: 3,
        userNoOpenStreakToPause: 5,
        emptyContentFallback: '本周行业热点摘要',
      },
      pushSlot: {
        channel: 'ding_work_notification',
        target: 'self',
        humanReviewRequired: false,
      },
      activationFallback: {
        withoutData: '用示例演示',
        degradedContent: '示例结果',
      },
      firstAhaMode: 'zero_input_example',
      dataDependencyLevel: 'zero',
      humanAuditPolicy: 'ai_draft_human_review_human_send',
      salesPitch: {
        oralScript: '内部销售话术',
        demoSteps: ['第一步'],
        bossQnA: [{ q: '老板问', a: '内部回答' }],
      },
      source: 'manus:120205',
      enabled: true,
    },
    {
      id: 'disabled-scenario',
      title: '未上架场景',
      role: 'sales',
      industries: ['all'],
      mode: 'oneshot',
      pitch: '不应出现在 API 响应中',
      story: 'a → b → c',
      promptTemplate: '测试',
      slots: [],
      requires: [],
      recommendCron: false,
      source: 'internal:draft',
      enabled: false,
    },
    {
      id: 'missing-enabled-scenario',
      title: '缺少 enabled 字段的场景',
      role: 'sales',
      industries: ['all'],
      mode: 'oneshot',
      pitch: '缺省视为未上架，不应下发',
      story: 'a → b → c',
      promptTemplate: '测试',
      slots: [],
      requires: [],
      recommendCron: false,
      source: 'internal:draft',
    },
  ],
};

describe('scenarios routes', () => {
  let tmpDir = '';
  let dataPath = '';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scenarios-routes-'));
    dataPath = join(tmpDir, 'scenario-library.json');
    await writeFile(dataPath, JSON.stringify(FIXTURE), 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns only enabled scenarios with roles sorted by sort', async () => {
    const { server, baseUrl } = await startServer(dataPath);
    try {
      const response = await fetch(`${baseUrl}/api/scenarios`);
      expect(response.status).toBe(200);
      const json = await response.json() as {
        roles: Array<{ id: string; sort: number }>;
        scenarios: Array<Record<string, unknown>>;
      };
      // 岗位按 sort 升序
      expect(json.roles.map((r) => r.id)).toEqual(['boss', 'sales']);
      // 仅 enabled === true 的条目下发（enabled: false / 缺省均不下发）
      expect(json.scenarios.map((s) => s.id)).toEqual(['boss-competitor-daily']);
    } finally {
      await stopServer(server);
    }
  });

  it('strips internal source and enabled fields but keeps public fields intact', async () => {
    const { server, baseUrl } = await startServer(dataPath);
    try {
      const response = await fetch(`${baseUrl}/api/scenarios`);
      expect(response.status).toBe(200);
      const json = await response.json() as { scenarios: Array<Record<string, unknown>> };
      const item = json.scenarios[0];
      // 内部字段必须剥离
      expect(item).not.toHaveProperty('source');
      expect(item).not.toHaveProperty('enabled');
      expect(item).not.toHaveProperty('salesPitch');
      // 公开字段原样保留
      expect(item.title).toBe('竞品动态晨报');
      expect(item.mode).toBe('recurring');
      expect(item.promptTemplate).toBe('帮我盯着这几家同行：{{competitors}}。');
      expect(item.slots).toEqual([
        { key: 'competitors', label: '同行公司名单', example: '同行A、同行B' },
      ]);
      expect(item.requires).toEqual(['web', 'dingtalk']);
      expect(item.industries).toEqual(['all']);
      expect(item.recommendCron).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it('serves the bundled v1 data file by default without leaking source', async () => {
    // 不注入 dataPath，走随代码发布的默认数据文件
    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/api/scenarios`);
      expect(response.status).toBe(200);
      const json = await response.json() as {
        roles: Array<{ id: string; sort: number }>;
        scenarios: Array<Record<string, unknown>>;
      };
      expect(json.roles.length).toBeGreaterThan(0);
      expect(json.scenarios.length).toBeGreaterThan(0);
      // 全量条目均不得携带内部字段
      for (const item of json.scenarios) {
        expect(item).not.toHaveProperty('source');
        expect(item).not.toHaveProperty('enabled');
        expect(item).not.toHaveProperty('salesPitch');
      }
      // roles 已排序
      const sorts = json.roles.map((r) => r.sort);
      expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
    } finally {
      await stopServer(server);
    }
  });

  it('returns 500 when the data file is missing', async () => {
    const { server, baseUrl } = await startServer(join(tmpDir, 'not-exists.json'));
    try {
      const response = await fetch(`${baseUrl}/api/scenarios`);
      expect(response.status).toBe(500);
    } finally {
      await stopServer(server);
    }
  });

  it('returns roleKit config for the frontend feature flag', async () => {
    const { server, baseUrl } = await startServer(dataPath);
    try {
      const response = await fetch(`${baseUrl}/api/scenarios/config`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        roleKitV2Enabled: true,
        firstDayGuideBar: { enabled: false },
          libraryVersion: 'v2',
      });
    } finally {
      await stopServer(server);
    }
  });

  it('enables first-day guide bar only when the tenant setting is enabled', async () => {
    const { server, baseUrl } = await startServer(dataPath, undefined, { firstDayGuideBarEnabled: true });
    try {
      const response = await fetch(`${baseUrl}/api/scenarios/config`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        firstDayGuideBar: { enabled: true },
      });
    } finally {
      await stopServer(server);
    }
  });

  it('creates a cron job from a recurring scenario', async () => {
    const calls: Array<{ create: CronJobCreate; context?: { owner?: string; ownerName?: string } }> = [];
    const runNowCalls: string[] = [];
    const cronService = {
      async add(create: CronJobCreate, context?: { owner?: string; ownerName?: string }): Promise<CronJob> {
        calls.push({ create, context });
        return {
          id: 'cron-created-1',
          name: create.name,
          enabled: true,
          schedule: create.schedule,
          payload: create.payload,
          notify: create.notify,
          owner: context?.owner,
          ownerName: context?.ownerName,
          createdAtMs: 1_783_000_000_000,
          updatedAtMs: 1_783_000_000_000,
          state: {},
        };
      },
      async runNow(id: string): Promise<{ ran: boolean }> {
        runNowCalls.push(id);
        return { ran: true };
      },
    };
    const { server, baseUrl } = await startServer(dataPath, cronService);
    try {
      const response = await fetch(`${baseUrl}/api/scenarios/create-cron`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioId: 'boss-competitor-daily',
          monitorTargets: ['同行A', '同行B'],
          signalAdaptation: {
            dailyEmptyStreakToWeekly: 3,
            userNoOpenStreakToPause: 5,
            emptyContentFallback: '本周行业热点摘要',
          },
          pushSlot: {
            channel: 'ding_work_notification',
            target: 'self',
            humanReviewRequired: false,
          },
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        cronJobId: 'cron-created-1',
        scenarioId: 'boss-competitor-daily',
        runOnceImmediately: true,
      });
      expect(calls).toHaveLength(1);
      expect(runNowCalls).toEqual(['cron-created-1']);
      expect(calls[0].context).toEqual({ owner: 'user-1', ownerName: 'alice' });
      expect(calls[0].create.payload).toMatchObject({
        kind: 'agentTurn',
        message: expect.stringContaining('同行A、同行B'),
      });
    } finally {
      await stopServer(server);
    }
  });

  it('rejects create-cron for oneshot scenarios', async () => {
    const { server, baseUrl } = await startServer(dataPath, {
      async add() {
        throw new Error('should not be called');
      },
      async runNow() {
        throw new Error('should not be called');
      },
    });
    try {
      const response = await fetch(`${baseUrl}/api/scenarios/create-cron`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenarioId: 'disabled-scenario',
          monitorTargets: ['客户A'],
          signalAdaptation: {
            dailyEmptyStreakToWeekly: 3,
            userNoOpenStreakToPause: 5,
            emptyContentFallback: '本周行业热点摘要',
          },
          pushSlot: {
            channel: 'ding_work_notification',
            target: 'self',
            humanReviewRequired: false,
          },
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'scenario_not_recurring' });
    } finally {
      await stopServer(server);
    }
  });
});
