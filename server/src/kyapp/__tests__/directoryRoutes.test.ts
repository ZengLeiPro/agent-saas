/**
 * WP2b 目录端点（§3.6 / 附录 L）的鉴权矩阵、分页、410 双码与限速。
 *
 * 响应体一律过 `@kaiyan/ky-app-contract` 的官方校验器再断言业务语义——
 * 附录 L 的 `additionalProperties:false` 让「多返回一个字段」直接判红，
 * 这是 PII 白名单最省事也最硬的回归网。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  validateDirectoryChanges,
  validateDirectoryGone,
  validateDirectorySnapshot,
} from '@kaiyan/ky-app-contract';

import type { DirectoryGroup, DirectoryUser } from '../directory/types.js';
import {
  TEST_IID,
  TEST_TENANT,
  createKyAppTestRig,
  seedPublishedInstallation,
  type KyAppTestRig,
  type KyAppTestRigOptions,
} from './harness.js';

const BASE = '/api/app-contract/v1';
const rigs: KyAppTestRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((item) => item.close()));
});

async function rig(options: KyAppTestRigOptions = {}): Promise<KyAppTestRig> {
  const created = await createKyAppTestRig(options);
  rigs.push(created);
  await seedPublishedInstallation(created);
  // 目录端点不经会话中间件，测试里把身份清掉，证明鉴权只靠服务凭据。
  created.setUser(null);
  return created;
}

/** 签发 → 领取 → 确认，拿到一枚 active 的服务凭据明文。 */
async function activeCredential(
  harness: KyAppTestRig,
  scopes?: readonly ('snapshot' | 'changes' | 'credential-ack')[],
  installationId = TEST_IID,
): Promise<string> {
  const issued = await harness.credentials.issue({
    installationId,
    ...(scopes ? { scopes } : {}),
  });
  const claimed = await harness.credentials.claim({ installationId, ticket: issued.ticket });
  await harness.credentials.acknowledge(claimed.serviceCredential);
  return claimed.serviceCredential;
}

function auth(credential: string): RequestInit {
  return { headers: { authorization: `Bearer ${credential}` } };
}

function user(id: string, override: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    userId: id,
    displayName: `员工 ${id}`,
    status: 'active',
    isTenantAdmin: false,
    groupIds: ['g-root'],
    ...override,
  };
}

function group(id: string): DirectoryGroup {
  return { groupId: id, displayName: `部门 ${id}`, status: 'active' };
}

/** 逐页拉完整份快照，返回每页原始响应体。 */
async function drainSnapshot(
  harness: KyAppTestRig,
  credential: string,
): Promise<Array<Record<string, unknown>>> {
  const pages: Array<Record<string, unknown>> = [];
  let query = '';
  for (let guard = 0; guard < 20; guard += 1) {
    const response = await harness.request(`${BASE}/directory/snapshot${query}`, auth(credential));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    pages.push(body);
    const next = body.pageToken;
    if (typeof next !== 'string') break;
    query = `?pageToken=${encodeURIComponent(next)}`;
  }
  return pages;
}

describe('目录端点鉴权（服务凭据 Bearer + scope）', () => {
  it('无 Bearer / 错凭据 / 缺 scope 一律 401，且不泄漏区别', async () => {
    const harness = await rig();
    const changesOnly = await activeCredential(harness, ['changes']);

    for (const path of ['/directory/snapshot', '/directory/changes?after=0']) {
      expect((await harness.request(`${BASE}${path}`)).status).toBe(401);
      expect((await harness.request(`${BASE}${path}`, auth('bogus-token'))).status).toBe(401);
    }
    // 只有 changes scope 的凭据打 snapshot → 401；打 changes → 200。
    const denied = await harness.request(`${BASE}/directory/snapshot`, auth(changesOnly));
    expect(denied.status).toBe(401);
    expect((await denied.json()) as { error: { message: string } }).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(
      (await harness.request(`${BASE}/directory/changes?after=0`, auth(changesOnly))).status,
    ).toBe(200);
  });

  it('实例已停用 → 403 installation_disabled；已删除同样拒绝', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    for (const status of ['disabled', 'deleted'] as const) {
      await harness.systems.updateInstallationStatus({
        installationId: TEST_IID,
        status,
        actor: 'u_seed',
      });
      const response = await harness.request(`${BASE}/directory/snapshot`, auth(credential));
      expect(response.status).toBe(403);
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: 'installation_disabled' },
      });
    }
  });

  it('组织 id 只从凭据推导：请求参数里塞 tenantId 完全无效', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 9,
      users: [user('u-1')],
      groups: [],
    });
    harness.directorySnapshots.set('t_other', {
      snapshotSeq: 99,
      users: [user('spy-1')],
      groups: [],
    });
    const response = await harness.request(
      `${BASE}/directory/snapshot?tenantId=t_other&tid=t_other`,
      auth(credential),
    );
    const body = (await response.json()) as { snapshotSeq: number; users: DirectoryUser[] };
    expect(body.snapshotSeq).toBe(9);
    expect(body.users.map((item) => item.userId)).toEqual(['u-1']);
  });
});

describe('快照分页（§3.6 所有页 snapshotSeq 相同）', () => {
  it('逐页拉完不重不漏，pageToken 只在还有下一页时出现，每页都合附录 L', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 128,
      users: ['u-1', 'u-2', 'u-3'].map((id) => user(id)),
      groups: ['g-a', 'g-b'].map(group),
    });

    const pages = await drainSnapshot(harness, credential);
    // 5 个实体 / 每页 2（harness 默认） → 3 页。
    expect(pages).toHaveLength(3);
    for (const page of pages) expect(validateDirectorySnapshot(page).ok).toBe(true);
    expect(pages.map((page) => page.snapshotSeq)).toEqual([128, 128, 128]);
    expect(pages.map((page) => typeof page.pageToken)).toEqual(['string', 'string', 'undefined']);

    const users = pages.flatMap((page) => page.users as DirectoryUser[]);
    const groups = pages.flatMap((page) => page.groups as DirectoryGroup[]);
    expect(users.map((item) => item.userId)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(groups.map((item) => item.groupId)).toEqual(['g-a', 'g-b']);
  });

  it('pageToken 过期 → 410 snapshot_expired，响应体是附录 L 的 {code, requestId}', async () => {
    let clock = Date.parse('2026-09-06T10:00:00.000Z');
    const harness = await rig({ now: () => clock });
    const credential = await activeCredential(harness);
    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 7,
      users: ['u-1', 'u-2', 'u-3'].map((id) => user(id)),
      groups: [],
    });

    const first = (await (
      await harness.request(`${BASE}/directory/snapshot`, auth(credential))
    ).json()) as { pageToken: string };
    expect(typeof first.pageToken).toBe('string');

    // 注入时钟推过 10 分钟 TTL，不真实等待。
    clock += 10 * 60 * 1000 + 1;
    const expired = await harness.request(
      `${BASE}/directory/snapshot?pageToken=${encodeURIComponent(first.pageToken)}`,
      auth(credential),
    );
    expect(expired.status).toBe(410);
    const body = (await expired.json()) as Record<string, unknown>;
    expect(validateDirectoryGone(body).ok).toBe(true);
    expect(body.code).toBe('snapshot_expired');
    expect(typeof body.requestId).toBe('string');
    // 附录 L 的 410 体不是附录 D 的 {ok:false,error:{...}} 形态。
    expect(body.ok).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  it('翻页期间目录变了（snapshotSeq 变化）→ 410 snapshot_expired', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 10,
      users: ['u-1', 'u-2', 'u-3'].map((id) => user(id)),
      groups: [],
    });
    const first = (await (
      await harness.request(`${BASE}/directory/snapshot`, auth(credential))
    ).json()) as { pageToken: string };

    // 一次投影落地：水位前移。
    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 11,
      users: ['u-1', 'u-2', 'u-3', 'u-4'].map((id) => user(id)),
      groups: [],
    });
    const stale = await harness.request(
      `${BASE}/directory/snapshot?pageToken=${encodeURIComponent(first.pageToken)}`,
      auth(credential),
    );
    expect(stale.status).toBe(410);
    expect((await stale.json()) as { code: string }).toMatchObject({ code: 'snapshot_expired' });
  });

  it('别的安装实例签出来的 pageToken 验不过 → 410（token 按实例密钥隔离）', async () => {
    const harness = await rig();
    const mine = await activeCredential(harness);
    await harness.systems.createInstallation({
      installationId: 'tsi_demo_02',
      tenantId: TEST_TENANT,
      systemId: 'demo-erp',
      baseUrl: 'https://erp2.example.com',
      origin: 'https://erp2.example.com',
      techContactUserId: 'u_tech',
      actor: 'u_seed',
    });
    await harness.systems.updateInstallationStatus({
      installationId: 'tsi_demo_02',
      status: 'enabled',
      actor: 'u_seed',
    });
    const other = await activeCredential(harness, undefined, 'tsi_demo_02');

    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 3,
      users: ['u-1', 'u-2', 'u-3'].map((id) => user(id)),
      groups: [],
    });
    const token = (
      (await (await harness.request(`${BASE}/directory/snapshot`, auth(other))).json()) as {
        pageToken: string;
      }
    ).pageToken;
    const crossed = await harness.request(
      `${BASE}/directory/snapshot?pageToken=${encodeURIComponent(token)}`,
      auth(mine),
    );
    expect(crossed.status).toBe(410);
    expect((await crossed.json()) as { code: string }).toMatchObject({ code: 'snapshot_expired' });
  });

  it('PII 白名单：响应体里查无手机号 / 邮箱 / 凭据字段', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    harness.directorySnapshots.set(TEST_TENANT, {
      snapshotSeq: 1,
      users: [
        {
          ...user('u-1', { employeeNo: 'E-0007', isTenantAdmin: true }),
          phone: '13800000000',
          email: 'a@example.com',
          passwordHash: '$argon2id$x',
        } as unknown as DirectoryUser,
      ],
      groups: [],
    });
    const response = await harness.request(`${BASE}/directory/snapshot`, auth(credential));
    const text = await response.text();
    expect(validateDirectorySnapshot(JSON.parse(text) as unknown).ok).toBe(true);
    expect(text).not.toMatch(/(phone|mobile|email|password|token|secret)/iu);
    expect(text).not.toContain('13800000000');
    expect(text).toContain('E-0007');
  });
});

describe('变更流（§3.6 changes?after=&limit=）', () => {
  it('按 seq 续流，nextSeq / hasMore 正确，事件形状合附录 L', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    harness.directoryChanges.append([
      {
        tenantId: TEST_TENANT,
        source: 'governance',
        type: 'group.upsert',
        entityId: 'g-a',
        payload: group('g-a'),
      },
      {
        tenantId: TEST_TENANT,
        source: 'governance',
        type: 'user.upsert',
        entityId: 'u-1',
        payload: user('u-1'),
      },
      { tenantId: TEST_TENANT, source: 'governance', type: 'user.remove', entityId: 'u-2' },
      // 另一个组织的事件绝不能串过来。
      {
        tenantId: 't_other',
        source: 'governance',
        type: 'user.upsert',
        entityId: 'x-1',
        payload: user('x-1'),
      },
    ]);

    const first = await harness.request(
      `${BASE}/directory/changes?after=0&limit=2`,
      auth(credential),
    );
    const firstBody = (await first.json()) as {
      events: Array<{ seq: number; type: string }>;
      nextSeq: number;
      hasMore: boolean;
    };
    expect(validateDirectoryChanges(firstBody).ok).toBe(true);
    expect(firstBody.events.map((event) => event.type)).toEqual(['group.upsert', 'user.upsert']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextSeq).toBe(2);

    const second = (await (
      await harness.request(
        `${BASE}/directory/changes?after=${String(firstBody.nextSeq)}&limit=500`,
        auth(credential),
      )
    ).json()) as {
      events: Array<{ type: string; userId?: string }>;
      nextSeq: number;
      hasMore: boolean;
    };
    expect(validateDirectoryChanges(second).ok).toBe(true);
    expect(second.events).toEqual([
      { seq: 3, eventId: expect.any(String), type: 'user.remove', userId: 'u-2' },
    ]);
    expect(second.hasMore).toBe(false);

    // 追平后再拉：空批、nextSeq 停在游标不动。
    const empty = (await (
      await harness.request(`${BASE}/directory/changes?after=3`, auth(credential))
    ).json()) as { events: unknown[]; nextSeq: number; hasMore: boolean };
    expect(empty).toEqual({ events: [], nextSeq: 3, hasMore: false });
  });

  it('after 早于 30 天保留下界 → 410 cursor_expired', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    harness.directoryChanges.append(
      ['u-1', 'u-2', 'u-3', 'u-4'].map((id) => ({
        tenantId: TEST_TENANT,
        source: 'governance' as const,
        type: 'user.upsert' as const,
        entityId: id,
        payload: user(id),
      })),
    );
    // 清掉 seq ≤ 2 → 下界抬到 2，after=1 落在被清掉的号段里。
    expect(harness.directoryChanges.purgeUpTo(2)).toBe(2);
    const gone = await harness.request(`${BASE}/directory/changes?after=1`, auth(credential));
    expect(gone.status).toBe(410);
    const body = (await gone.json()) as Record<string, unknown>;
    expect(validateDirectoryGone(body).ok).toBe(true);
    expect(body.code).toBe('cursor_expired');
    // 恰好等于下界不算过期（下一条就是 MIN(seq)）。
    expect(
      (await harness.request(`${BASE}/directory/changes?after=2`, auth(credential))).status,
    ).toBe(200);
  });

  it('after / limit 非法 → 400 invalid_input；limit 超上限收敛到 500', async () => {
    const harness = await rig();
    const credential = await activeCredential(harness);
    for (const query of ['after=-1', 'after=abc', 'limit=0', 'limit=abc', 'after=1.5']) {
      const response = await harness.request(
        `${BASE}/directory/changes?${query}`,
        auth(credential),
      );
      expect(response.status, query).toBe(400);
    }
    expect(
      (await harness.request(`${BASE}/directory/changes?limit=99999`, auth(credential))).status,
    ).toBe(200);
  });
});

describe('限速（§3.6 每租户每分钟 ≤ 60）', () => {
  it('第 61 次 429 且带 Retry-After；两个端点共用同一个租户配额', async () => {
    let clock = Date.parse('2026-09-06T10:00:00.000Z');
    const harness = await rig({ now: () => clock });
    const credential = await activeCredential(harness);
    harness.directorySnapshots.set(TEST_TENANT, { snapshotSeq: 1, users: [], groups: [] });

    for (let index = 0; index < 30; index += 1) {
      expect((await harness.request(`${BASE}/directory/snapshot`, auth(credential))).status).toBe(
        200,
      );
      expect(
        (await harness.request(`${BASE}/directory/changes?after=0`, auth(credential))).status,
      ).toBe(200);
    }
    const denied = await harness.request(`${BASE}/directory/snapshot`, auth(credential));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await denied.json()) as unknown).toMatchObject({
      error: { code: 'rate_limited', retryable: true },
    });

    // 窗口滑过后恢复。
    clock += 60_001;
    expect((await harness.request(`${BASE}/directory/snapshot`, auth(credential))).status).toBe(
      200,
    );
  });
});
