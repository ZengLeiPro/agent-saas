import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgApnsDeviceStore } from '../apns/store.js';
import { PgWebPushStore } from '../webPush/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
const owner = { tenantId: 'tenant-a', userId: 'user-a' };

/**
 * 推送投递 claim 的真实 PostgreSQL 契约：`updated_at` 在 PG 是微秒精度，pg 驱动转成 JS Date
 * 后只剩毫秒。claim 必须按毫秒比较，否则每次投递都会被判成「记录已变更」而跳过——
 * 这正是 Web Push 上线以来从未真正投递的原因，APNs 抄了同款。
 */
describePg('推送投递 claim 的 PostgreSQL 时间精度契约', () => {
  const prefix = `pdc_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  let pool: InstanceType<typeof Pool>;
  let webPush: PgWebPushStore;
  let apns: PgApnsDeviceStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    webPush = new PgWebPushStore({ pool, tablePrefix: prefix });
    apns = new PgApnsDeviceStore({ pool, tablePrefix: prefix });
    await Promise.all([webPush.init(), apns.init()]);
  });

  afterAll(async () => {
    await pool.query(
      `DROP TABLE IF EXISTS ${prefix}_web_push_deliveries, ${prefix}_web_push_subscriptions, ${prefix}_apns_deliveries, ${prefix}_apns_devices`,
    );
    await pool.end();
  });

  it('Web Push：列出的订阅能被 claim，同一事件第二次为 null，重绑后旧快照失效', async () => {
    await webPush.save(owner, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/one',
      keys: { p256dh: 'p', auth: 'a' },
      deviceName: 'Chrome',
    });
    const [listed] = await webPush.list(owner);
    expect(listed).toBeDefined();
    const micro = await pool.query<{ micro: string }>(
      `SELECT to_char(updated_at, 'US') AS micro FROM ${prefix}_web_push_subscriptions`,
    );
    // 测试前提：PG 侧确实带微秒（否则本用例测不到精度问题）。
    expect(micro.rows[0]!.micro).toHaveLength(6);

    const claim = await webPush.claimDelivery(owner, listed!, 'event-1');
    expect(claim && !('deferred' in claim)).toBe(true);
    if (claim && !('deferred' in claim)) await claim.finish('sent');
    expect(await webPush.claimDelivery(owner, listed!, 'event-1')).toBeNull();

    // 重绑（updated_at 前进）后，旧快照不再匹配。
    await new Promise((resolve) => setTimeout(resolve, 5));
    await webPush.save(owner, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/one',
      keys: { p256dh: 'p2', auth: 'a2' },
      deviceName: 'Chrome',
    });
    expect(await webPush.claimDelivery(owner, listed!, 'event-2')).toBeNull();
    const [relisted] = await webPush.list(owner);
    const second = await webPush.claimDelivery(owner, relisted!, 'event-2');
    expect(second && !('deferred' in second)).toBe(true);
    if (second && !('deferred' in second)) await second.finish('sent');
  });

  it('APNs：设备能被 claim，失败记录一分钟内返回 deferred，invalidate 同时清理投递记录', async () => {
    await apns.save(owner, {
      token: 'ab'.repeat(32),
      environment: 'production',
      deviceName: 'iPhone',
    });
    const [device] = await apns.list(owner);
    const claim = await apns.claimDelivery(owner, device!, 'event-1');
    expect(claim && !('deferred' in claim)).toBe(true);
    if (claim && !('deferred' in claim)) await claim.finish('failed', 'boom');
    expect(await apns.claimDelivery(owner, device!, 'event-1')).toEqual({ deferred: true });

    const other = await apns.claimDelivery(owner, device!, 'event-2');
    expect(other && !('deferred' in other)).toBe(true);
    if (other && !('deferred' in other)) await other.invalidate();
    expect(await apns.list(owner)).toEqual([]);
    const deliveries = await pool.query(
      `SELECT count(*)::int AS n FROM ${prefix}_apns_deliveries WHERE device_id=$1`,
      [device!.id],
    );
    expect(deliveries.rows[0].n).toBe(0);
  });
});
