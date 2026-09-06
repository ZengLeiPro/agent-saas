/**
 * WP4 壳侧安全事件通道（规范 §5.4-3「记安全事件」、`agent.open` 审计；
 * 总控对 4-A-01 的拍板：非法应用内路径的五类拒绝原因也走同一通道）。
 *
 * 只有路由 + 治理审计是生产代码，存储是内存替身（`kyapp/__tests__/harness.ts`）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  MEMBER,
  TEST_IID,
  createKyAppTestRig,
  json,
  type KyAppTestRig,
} from '../kyapp/__tests__/harness.js';
import { KY_APP_SHELL_EVENTS } from '../kyapp/routes/shellEvents.js';

const BASE = '/api/app-contract/v1';
const rigs: KyAppTestRig[] = [];

async function rig(): Promise<KyAppTestRig> {
  const created = await createKyAppTestRig();
  rigs.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((item) => item.close()));
});

describe('POST /api/app-contract/v1/shell-events', () => {
  it('普通成员可以上报，事件落治理审计并带 origin:app_iframe 与 installationId', async () => {
    const harness = await rig();
    harness.setUser(MEMBER);
    const response = await harness.request(
      `${BASE}/shell-events`,
      json('POST', {
        event: 'path_rejected',
        installationId: TEST_IID,
        reason: 'dot_segment',
        detail: '/a/../b',
      }),
    );
    expect(response.status).toBe(204);

    const event = harness.auditEvents.at(-1) as Record<string, unknown>;
    expect(event.action).toBe('ky_app.shell.path_rejected');
    expect(event.targetType).toBe('ky_app_installation');
    expect(event.targetId).toBe(TEST_IID);
    expect(event.actorUserId).toBe(MEMBER.sub);
    expect(event.reason).toBe('dot_segment');
    expect(event.result).toBe('failed');
    expect(event.metadata).toMatchObject({
      origin: 'app_iframe',
      installationId: TEST_IID,
      detail: '/a/../b',
    });
  });

  it('agent.open 记 succeeded，其余壳事件记 failed', async () => {
    const harness = await rig();
    harness.setUser(MEMBER);
    await harness.request(
      `${BASE}/shell-events`,
      json('POST', { event: 'agent_open', installationId: TEST_IID }),
    );
    expect((harness.auditEvents.at(-1) as Record<string, unknown>).result).toBe('succeeded');
    await harness.request(
      `${BASE}/shell-events`,
      json('POST', { event: 'link_blocked', installationId: TEST_IID, reason: 'not_allowlisted' }),
    );
    expect((harness.auditEvents.at(-1) as Record<string, unknown>).result).toBe('failed');
  });

  it('事件种类是闭集，未登录 401，非法体 400', async () => {
    const harness = await rig();
    harness.setUser(MEMBER);
    for (const event of KY_APP_SHELL_EVENTS) {
      const ok = await harness.request(
        `${BASE}/shell-events`,
        json('POST', { event, installationId: TEST_IID }),
      );
      expect(ok.status, event).toBe(204);
    }
    const unknown = await harness.request(
      `${BASE}/shell-events`,
      json('POST', { event: 'anything_goes', installationId: TEST_IID }),
    );
    expect(unknown.status).toBe(400);

    const badIid = await harness.request(
      `${BASE}/shell-events`,
      json('POST', { event: 'path_rejected', installationId: '../../etc' }),
    );
    expect(badIid.status).toBe(400);

    harness.setUser(null);
    const anonymous = await harness.request(
      `${BASE}/shell-events`,
      json('POST', { event: 'path_rejected', installationId: TEST_IID }),
    );
    expect(anonymous.status).toBe(401);
  });

  it('detail 超长被拒（审计只收有界观测值）', async () => {
    const harness = await rig();
    harness.setUser(MEMBER);
    const response = await harness.request(
      `${BASE}/shell-events`,
      json('POST', {
        event: 'message_rejected',
        installationId: TEST_IID,
        detail: 'x'.repeat(201),
      }),
    );
    expect(response.status).toBe(400);
  });
});
