/**
 * WP2b × WP1 目录闭环：**真实的 `DirectoryClient` 打真实的平台路由**（等价 §9.3-12）。
 *
 * 照 `wp1Interop.test.ts` 的模式——只有「存储」是替身，消费算法、限速、410 处理、
 * 附录 L 校验、快照/变更流路由、服务凭据鉴权全部是两侧的生产代码本身。
 * 两侧对 `snapshotSeq` 语义、`nextSeq` 语义、410 双码、分页游标的理解只要有一处不一致，
 * 这个文件就会红。
 *
 * §9.3-12 的四条逐条覆盖：
 * 1. 快照分页应用后从 `snapshotSeq` 续流**无丢失**；
 * 2. `seq ≤ checkpoint` **幂等**；
 * 3. 410 触发重快照（`snapshot_expired` 与 `cursor_expired` **两种都覆盖**）；
 * 4. 陈旧 > 2 小时写入口 `directory_stale`、> 24 小时读入口拒绝（**注入时钟**，不真实等待）。
 *
 * 第 4 条的 HTTP 层强制点在 WP1 的 `packages/ky-app-server/src/hono/middleware.ts:97-106`
 * （已由该包的 `routerFlows.test.ts` 覆盖）。本文件覆盖它的输入侧：
 * 「平台端点 → 真实 DirectoryClient → checkpoint 时间 → `staleness()` 三级门禁」这条链，
 * 并断言 `directory_stale` 在契约里就是 403。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  MemoryDirectoryStore,
  createDirectoryClient,
  type DirectoryClient,
  type KyAppConfig as SdkConfig,
} from '@kaiyan/ky-app-server';
import { ERROR_HTTP_STATUS } from '@kaiyan/ky-app-contract';

import type { AppendDirectoryChangeInput } from '../directory/changeLog.js';
import type { DirectoryGroup, DirectoryUser } from '../directory/types.js';
import {
  TEST_IID,
  TEST_TENANT,
  createKyAppTestRig,
  seedPublishedInstallation,
  type KyAppTestRig,
} from './harness.js';

const rigs: KyAppTestRig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((item) => item.close()));
});

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

function upsertUser(entity: DirectoryUser): AppendDirectoryChangeInput {
  return {
    tenantId: TEST_TENANT,
    source: 'governance',
    type: 'user.upsert',
    entityId: entity.userId,
    payload: entity,
  };
}

function upsertGroup(entity: DirectoryGroup): AppendDirectoryChangeInput {
  return {
    tenantId: TEST_TENANT,
    source: 'governance',
    type: 'group.upsert',
    entityId: entity.groupId,
    payload: entity,
  };
}

interface Interop {
  harness: KyAppTestRig;
  store: MemoryDirectoryStore;
  client: DirectoryClient;
  /** 把当前投影态与变更日志水位对齐后写进快照源（生产里由投影器保证）。 */
  publishSnapshot(users: DirectoryUser[], groups: DirectoryGroup[], seq?: number): Promise<void>;
  setClock(ms: number): void;
  /** 每次 snapshot 请求返回前执行一次的钩子，用来在翻页中途改动平台状态。 */
  onSnapshotResponse: { current: (() => void) | null };
}

/**
 * 起一套「平台真路由 + 定制项目真消费端」。
 * 平台侧与消费端共用同一个注入时钟，陈旧度与 pageToken TTL 都能被测试精确驱动。
 */
async function interop(): Promise<Interop> {
  let clock = Date.parse('2026-09-06T10:00:00.000Z');
  const harness = await createKyAppTestRig({ now: () => clock });
  rigs.push(harness);
  await seedPublishedInstallation(harness);
  harness.setUser(null);

  const issued = await harness.credentials.issue({ installationId: TEST_IID });
  const claimed = await harness.credentials.claim({
    installationId: TEST_IID,
    ticket: issued.ticket,
  });
  await harness.credentials.acknowledge(claimed.serviceCredential);

  const onSnapshotResponse: { current: (() => void) | null } = { current: null };
  const store = new MemoryDirectoryStore();
  const client = createDirectoryClient({
    config: {
      installationId: TEST_IID,
      serviceCredential: claimed.serviceCredential,
    } as unknown as SdkConfig,
    store,
    baseUrl: 'http://platform.invalid',
    now: () => clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const response = await harness.request(`${url.pathname}${url.search}`, init);
      if (url.pathname.endsWith('/directory/snapshot') && onSnapshotResponse.current) {
        const hook = onSnapshotResponse.current;
        onSnapshotResponse.current = null;
        hook();
      }
      return response;
    },
  });

  return {
    harness,
    store,
    client,
    onSnapshotResponse,
    setClock: (ms) => {
      clock = ms;
    },
    async publishSnapshot(users, groups, seq) {
      harness.directorySnapshots.set(TEST_TENANT, {
        snapshotSeq: seq ?? (await harness.directoryChanges.latestSeq(TEST_TENANT)),
        users,
        groups,
      });
    },
  };
}

describe('§9.3-12 目录：快照分页 → 续流无丢失', () => {
  it('分页快照落地后从 snapshotSeq 续流，后续每一条事件都不丢', async () => {
    const io = await interop();
    const groups = ['g-a', 'g-b'].map(group);
    const users = ['u-1', 'u-2', 'u-3'].map((id) => user(id));
    // 生产里快照与变更日志是同一个事务的两面；这里照同一顺序造。
    io.harness.directoryChanges.append([
      ...groups.map(upsertGroup),
      ...users.map((entity) => upsertUser(entity)),
    ]);
    await io.publishSnapshot(users, groups);

    const first = await io.client.sync();
    // harness 页大小 2，5 个实体 → 3 页，全部由真实 DirectoryClient 自己翻完。
    expect(first).toMatchObject({ status: 'snapshot', applied: 5, checkpoint: 5 });
    await expect(io.store.listUsers()).resolves.toHaveLength(3);
    await expect(io.store.listGroups()).resolves.toHaveLength(2);

    // 续流：停用一人、离职一人、加一个新部门。
    io.harness.directoryChanges.append([
      upsertUser(user('u-2', { status: 'disabled' })),
      { tenantId: TEST_TENANT, source: 'governance', type: 'user.remove', entityId: 'u-3' },
      upsertGroup(group('g-c')),
    ]);
    const second = await io.client.sync();
    expect(second).toMatchObject({ status: 'changes', applied: 3, checkpoint: 8 });

    await expect(io.store.getUser('u-2')).resolves.toMatchObject({ localStatus: 'suspended' });
    await expect(io.store.getUser('u-3')).resolves.toMatchObject({
      removed: true,
      localStatus: 'suspended',
    });
    await expect(io.store.listGroups()).resolves.toHaveLength(3);

    // 追平后再同步：空批、位点不动。
    await expect(io.client.sync()).resolves.toMatchObject({
      status: 'up-to-date',
      applied: 0,
      checkpoint: 8,
    });
  });

  it('单批超过 limit 时逐批续流，跨批不重不漏', async () => {
    const io = await interop();
    const many = Array.from({ length: 7 }, (_, index) => user(`u-${String(index + 1)}`));
    io.harness.directoryChanges.append(many.map((entity) => upsertUser(entity)));
    await io.publishSnapshot([], []);
    // 先把位点建起来（空快照，snapshotSeq=7 会让后续 changes 空转），改为从 0 起续流。
    await io.store.applyChanges({ events: [], nextSeq: 0, at: Date.now() });

    const result = await io.client.sync();
    expect(result.applied).toBe(7);
    expect(result.checkpoint).toBe(7);
    await expect(io.store.listUsers()).resolves.toHaveLength(7);
  });
});

describe('§9.3-12 目录：seq ≤ checkpoint 幂等', () => {
  it('快照水位落后于变更流时重复投递的事件被幂等吸收，状态不漂移', async () => {
    const io = await interop();
    const users = ['u-1', 'u-2'].map((id) => user(id));
    io.harness.directoryChanges.append(users.map((entity) => upsertUser(entity)));
    io.harness.directoryChanges.append([upsertUser(user('u-2', { employeeNo: 'E-42' }))]);
    // 故意把 snapshotSeq 造得偏小（生产里删除墓碑就会导致这种偏小，见 snapshot.ts 注释），
    // 于是续流时 seq=3 那条会被再投递一次。
    await io.publishSnapshot([users[0]!, user('u-2', { employeeNo: 'E-42' })], [], 2);

    await expect(io.client.sync()).resolves.toMatchObject({ status: 'snapshot', checkpoint: 2 });
    const before = await io.store.listUsers();
    const replayed = await io.client.sync();
    expect(replayed).toMatchObject({ status: 'changes', applied: 1, checkpoint: 3 });
    const after = await io.store.listUsers();
    expect(after.map((item) => ({ ...item, updatedAt: 0 }))).toEqual(
      before.map((item) => ({ ...item, updatedAt: 0 })),
    );
  });

  it('平台真实返回的一批 seq ≤ checkpoint 事件被本地存储直接忽略', async () => {
    const io = await interop();
    io.harness.directoryChanges.append([upsertUser(user('u-1')), upsertUser(user('u-2'))]);
    await io.publishSnapshot(
      ['u-1', 'u-2'].map((id) => user(id)),
      [],
    );
    await io.client.sync();
    await expect(io.store.getCheckpoint()).resolves.toMatchObject({ seq: 2 });

    // 从真端点重新取 seq 1..2（模拟至少一次投递下的重放），此时 checkpoint 已是 2。
    const response = await io.harness.request('/api/app-contract/v1/directory/changes?after=0', {
      headers: { authorization: `Bearer ${await credentialOf(io)}` },
    });
    const body = (await response.json()) as {
      events: { seq: number }[];
      nextSeq: number;
    };
    expect(body.events.map((event) => event.seq)).toEqual([1, 2]);
    await io.store.applyChanges({ events: body.events as never, nextSeq: body.nextSeq, at: 1 });
    // 位点不回退，用户表不重复。
    await expect(io.store.getCheckpoint()).resolves.toMatchObject({ seq: 2 });
    await expect(io.store.listUsers()).resolves.toHaveLength(2);
  });
});

describe('§9.3-12 目录：两种 410 都触发重快照', () => {
  it('cursor_expired（游标早于 30 天保留期）→ 消费端整份重拉', async () => {
    const io = await interop();
    io.harness.directoryChanges.append(['u-1', 'u-2', 'u-3'].map((id) => upsertUser(user(id))));
    await io.publishSnapshot(
      ['u-1', 'u-2', 'u-3'].map((id) => user(id)),
      [],
    );
    await io.client.sync();
    await expect(io.store.getCheckpoint()).resolves.toMatchObject({ seq: 3 });

    // 保留清理把整段号段删掉，游标落在下界之前。
    io.harness.directoryChanges.append([upsertUser(user('u-4'))]);
    io.harness.directoryChanges.purgeUpTo(4);
    io.harness.directoryChanges.append([upsertUser(user('u-5'))]);
    await io.publishSnapshot(
      ['u-1', 'u-2', 'u-3', 'u-4', 'u-5'].map((id) => user(id)),
      [],
    );

    const resnapshot = await io.client.sync();
    expect(resnapshot).toMatchObject({ status: 'snapshot', resnapshot: true, checkpoint: 5 });
    await expect(io.store.listUsers()).resolves.toHaveLength(5);
  });

  it('snapshot_expired（翻页中途目录变了）→ 消费端丢弃残页并整份重拉', async () => {
    const io = await interop();
    const users = ['u-1', 'u-2', 'u-3', 'u-4'].map((id) => user(id));
    io.harness.directoryChanges.append(users.map((entity) => upsertUser(entity)));
    await io.publishSnapshot(users, []);

    // 第一页返回之后，平台侧再投影一次：水位前移 → 第二页必然 410。
    io.onSnapshotResponse.current = () => {
      io.harness.directoryChanges.append([upsertUser(user('u-5'))]);
      io.harness.directorySnapshots.set(TEST_TENANT, {
        snapshotSeq: 5,
        users: [...users, user('u-5')],
        groups: [],
      });
    };

    const result = await io.client.sync();
    expect(result).toMatchObject({ status: 'snapshot', resnapshot: true, checkpoint: 5 });
    await expect(io.store.listUsers()).resolves.toHaveLength(5);
    // 残页没有被当成完整快照落地：u-5 在库里，且没有任何用户被误标离职。
    const listed = await io.store.listUsers();
    expect(listed.filter((item) => item.removed)).toHaveLength(0);
  });
});

describe('§9.3-12 目录：陈旧度门禁（注入时钟）', () => {
  it('> 2 小时写入口 directory_stale、> 24 小时读入口也拒；同步一次即恢复', async () => {
    const io = await interop();
    const base = Date.parse('2026-09-06T10:00:00.000Z');
    io.harness.directoryChanges.append([upsertUser(user('u-1'))]);
    await io.publishSnapshot([user('u-1')], []);

    // 从未同步过 → fail-closed。
    await expect(io.client.staleness()).resolves.toMatchObject({
      warn: true,
      allowWrite: false,
      allowRead: false,
    });

    await io.client.sync();
    await expect(io.client.staleness()).resolves.toMatchObject({
      warn: false,
      allowWrite: true,
      allowRead: true,
    });

    // 30 分钟：告警但不阻断。
    io.setClock(base + 31 * 60 * 1000);
    await expect(io.client.staleness()).resolves.toMatchObject({
      warn: true,
      allowWrite: true,
      allowRead: true,
    });

    // 2 小时零 1 秒：写入口拒绝，读仍放行。
    io.setClock(base + 2 * 60 * 60 * 1000 + 1_000);
    await expect(io.client.staleness()).resolves.toMatchObject({
      warn: true,
      allowWrite: false,
      allowRead: true,
    });

    // 24 小时零 1 秒：读入口也拒绝。
    io.setClock(base + 24 * 60 * 60 * 1000 + 1_000);
    await expect(io.client.staleness()).resolves.toMatchObject({
      allowWrite: false,
      allowRead: false,
    });

    // 客户面语义：directory_stale 在契约里就是 403。
    expect(ERROR_HTTP_STATUS.directory_stale).toBe(403);

    // 再同步一次（此刻平台仍可达）→ 位点时间刷新，门禁全开。
    await io.client.sync();
    await expect(io.client.staleness()).resolves.toMatchObject({
      warn: false,
      allowWrite: true,
      allowRead: true,
    });
  });
});

/** 取本 rig 当前那枚 active 服务凭据（只在需要绕过 client 直打端点时用）。 */
async function credentialOf(io: Interop): Promise<string> {
  const issued = await io.harness.credentials.issue({ installationId: TEST_IID });
  const claimed = await io.harness.credentials.claim({
    installationId: TEST_IID,
    ticket: issued.ticket,
  });
  await io.harness.credentials.acknowledge(claimed.serviceCredential);
  return claimed.serviceCredential;
}
