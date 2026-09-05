/**
 * §9.3-12：组织目录快照分页 → 续流无丢失、`seq ≤ checkpoint` 幂等、410 重快照、
 * 陈旧度三级门禁（>2 h 拒写、>24 h 拒读）。
 *
 * 与被测项目的约定：`POST /ky/v1/test/directory`
 *   `{action:'sync'}`      → 跑一轮 `directoryClient.sync()`，回 `{status, applied, checkpoint}`
 *   `{action:'state'}`     → 回 `{checkpoint, users:[{userId,...}], groups:[...]}`
 *   `{action:'staleness'}` → 回 `{ageSeconds, warn, allowWrite, allowRead}`
 */
import {
  DIRECTORY_STALENESS_SECONDS,
  type DirectoryGroup,
  type DirectoryUser,
} from '@kaiyan/ky-app-contract';

import { assert, expectErrorCode, expectStatus } from '../harness/http.js';
import { fixtureUsers, userApiPath } from './fixtures.js';
import type { DoctorContext } from './context.js';

interface DirectoryState {
  checkpoint: number | null;
  users: Array<{ userId: string; removed?: boolean; localStatus?: string }>;
  groups: Array<{ groupId: string }>;
}

interface SyncResult {
  status: string;
  applied: number;
  checkpoint: number | null;
  resnapshot?: boolean;
}

function user(userId: string, extra: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    userId,
    displayName: `目录用户 ${userId}`,
    status: 'active',
    isTenantAdmin: false,
    groupIds: ['g-root'],
    ...extra,
  };
}

function group(groupId: string, displayName: string): DirectoryGroup {
  return { groupId, displayName, parentGroupId: null, status: 'active' };
}

export async function chapter12(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(12);
  const directory = ctx.shell.directory;
  const users = fixtureUsers(ctx);

  async function sync(): Promise<SyncResult> {
    const result = await ctx.testHook('directory', { action: 'sync' });
    expectStatus(result, 200, 'POST /ky/v1/test/directory {action:sync}');
    return (result.json as { result: SyncResult }).result;
  }

  async function state(): Promise<DirectoryState> {
    const result = await ctx.testHook('directory', { action: 'state' });
    expectStatus(result, 200, 'POST /ky/v1/test/directory {action:state}');
    return (result.json as { result: DirectoryState }).result;
  }

  await reporter.check('快照分页逐页应用（pageToken 走完全部页）', async () => {
    // doctor 启动时已经同步过一轮种子数据，这里先让游标过期，逼消费端整份重拉。
    directory.expireCursor();
    directory.setSnapshot({
      snapshotSeq: 10,
      groups: [group('g-root', '总部')],
      users: [user('d1'), user('d2'), user('d3'), user('d4'), user('d5')],
    });
    const callsBefore = directory.calls.length;
    const result = await sync();
    assert(result.status === 'snapshot', `期望 status=snapshot，实际 ${result.status}`);
    assert(result.checkpoint === 10, `期望 checkpoint=10，实际 ${String(result.checkpoint)}`);
    const pages = directory.calls
      .slice(callsBefore)
      .filter((path) => path.startsWith('/api/app-contract/v1/directory/snapshot'));
    assert(pages.length >= 3, `5 个用户按每页 2 条应至少 3 页，实际 ${String(pages.length)} 页`);
    const local = await state();
    // 旧用户不会被删，只会标 removed（§3.4 离职数据保留），所以只数在册的。
    const active = local.users.filter((item) => item.removed !== true);
    assert(active.length === 5, `本地在册用户应为 5 个，实际 ${String(active.length)}`);
    assert(local.checkpoint === 10, `本地 checkpoint 应为 10，实际 ${String(local.checkpoint)}`);
  });

  await reporter.check('从 snapshotSeq 续流无丢失', async () => {
    directory.pushEvents([
      { eventId: 'e-11', type: 'user.upsert', user: user('d6') },
      { eventId: 'e-12', type: 'group.upsert', group: group('g-sales', '销售部') },
      { eventId: 'e-13', type: 'user.remove', userId: 'd5' },
    ]);
    const result = await sync();
    assert(result.status === 'changes', `期望 status=changes，实际 ${result.status}`);
    assert(result.checkpoint === 13, `期望 checkpoint=13，实际 ${String(result.checkpoint)}`);
    const local = await state();
    const ids = local.users.map((item) => item.userId).sort((a, b) => a.localeCompare(b));
    assert(ids.includes('d6'), `续流后应出现 d6，实际 ${ids.join(',')}`);
    const removed = local.users.find((item) => item.userId === 'd5');
    assert(removed?.removed === true, 'user.remove 后 d5 应被标记为已移除（数据保留）');
    assert(local.groups.length === 2, `分组应为 2 个，实际 ${String(local.groups.length)}`);
  });

  await reporter.check('seq ≤ checkpoint 的事件被幂等忽略', async () => {
    const before = await state();
    // 让服务端把 seq 11..13 重新发一遍（含 d6 的 upsert 与 d5 的 remove）。
    directory.replayNextChangesFrom(11);
    const result = await sync();
    assert(
      result.checkpoint === 13,
      `重放后 checkpoint 不应回退，实际 ${String(result.checkpoint)}`,
    );
    const after = await state();
    assert(
      JSON.stringify(after.users.map((item) => item.userId).sort((a, b) => a.localeCompare(b))) ===
        JSON.stringify(before.users.map((item) => item.userId).sort((a, b) => a.localeCompare(b))),
      '重放旧事件后本地用户集合发生了变化',
    );
  });

  await reporter.check('410 cursor_expired → 整份重拉快照', async () => {
    directory.expireCursor();
    directory.setSnapshot({
      snapshotSeq: 50,
      groups: [group('g-root', '总部')],
      users: [user('d1'), user('d7')],
    });
    const result = await sync();
    assert(result.status === 'snapshot', `期望重快照，实际 ${result.status}`);
    assert(result.resnapshot === true, '重快照应标记 resnapshot=true');
    assert(result.checkpoint === 50, `期望 checkpoint=50，实际 ${String(result.checkpoint)}`);
    const local = await state();
    assert(
      local.users.some((item) => item.userId === 'd7'),
      '重快照后应出现新用户 d7',
    );
  });

  const userApi = userApiPath(ctx);

  await reporter.check(
    `目录陈旧 > ${String(DIRECTORY_STALENESS_SECONDS.blockWrite / 3600)} 小时 → 写入口 directory_stale`,
    async () => {
      assert(userApi !== null, '夹具里没有 pathPrefixes.user 内的页面接口');
      const offsetMs = (DIRECTORY_STALENESS_SECONDS.blockWrite + 600) * 1000;
      try {
        await ctx.setClockOffset(offsetMs);
        const nowSeconds = Math.floor((Date.now() + offsetMs) / 1000);
        const write = await ctx.callAsUser(
          { method: 'POST', path: userApi, body: {} },
          { sub: users.member.sub, tadm: false, nowSeconds },
        );
        expectStatus(write, 403, '陈旧 > 2 小时的写入口');
        expectErrorCode(write, 'directory_stale', '陈旧 > 2 小时的写入口');
        const read = await ctx.callAsUser(
          { path: userApi },
          { sub: users.member.sub, tadm: false, nowSeconds },
        );
        expectStatus(read, 200, '陈旧 > 2 小时但 < 24 小时的读入口应仍可用');
      } finally {
        await ctx.setClockOffset(0);
      }
    },
  );

  await reporter.check(
    `目录陈旧 > ${String(DIRECTORY_STALENESS_SECONDS.blockRead / 3600)} 小时 → 读入口也拒绝，/me 仍可用`,
    async () => {
      assert(userApi !== null, '夹具里没有 pathPrefixes.user 内的页面接口');
      const offsetMs = (DIRECTORY_STALENESS_SECONDS.blockRead + 3600) * 1000;
      try {
        await ctx.setClockOffset(offsetMs);
        const nowSeconds = Math.floor((Date.now() + offsetMs) / 1000);
        const read = await ctx.callAsUser(
          { path: userApi },
          { sub: users.member.sub, tadm: false, nowSeconds },
        );
        expectStatus(read, 403, '陈旧 > 24 小时的读入口');
        expectErrorCode(read, 'directory_stale', '陈旧 > 24 小时的读入口');
        const me = await ctx.callAsUser(
          { path: '/ky/v1/me' },
          { sub: users.member.sub, tadm: false, nowSeconds },
        );
        expectStatus(me, 200, '陈旧 > 24 小时时 /me 仍应可用');
        const live = await ctx.call({ path: '/ky/v1/health/live' });
        expectStatus(live, 200, '陈旧 > 24 小时时 health/live 仍应可用');
      } finally {
        await ctx.setClockOffset(0);
        await sync();
      }
    },
  );

  await reporter.check('credential-ack 已确认（§3.6 服务凭据 24 小时内确认）', async () => {
    const result = await ctx.testHook('directory', { action: 'ack' });
    expectStatus(result, 200, 'POST /ky/v1/test/directory {action:ack}');
    assert(directory.credentialAcked(), 'mock 目录服务没有收到 credential-ack');
  });
}
