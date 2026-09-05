import { describe, expect, it } from 'vitest';
import { isCronEntryVisible, type CronEntryVisibilityInput } from './cronEntry';

const allOn: CronEntryVisibilityInput = {
  isAdmin: false,
  personalAgentEnabled: true,
  cronEnabled: true,
  routeAllowed: true,
};

describe('isCronEntryVisible', () => {
  it('三个条件全部成立时露出入口', () => {
    expect(isCronEntryVisible(allOn)).toBe(true);
    expect(isCronEntryVisible({ ...allOn, isAdmin: true })).toBe(true);
  });

  it('个人 Agent 不可用时隐藏（personalAgentOnly，与 Web getSidebarNavItems 一致）', () => {
    expect(isCronEntryVisible({ ...allOn, personalAgentEnabled: false })).toBe(false);
  });

  it('租户关闭定时任务时隐藏', () => {
    expect(isCronEntryVisible({ ...allOn, cronEnabled: false })).toBe(false);
  });

  it('V1 档位不放行 cron 路由时隐藏（生产 fail closed）', () => {
    expect(isCronEntryVisible({ ...allOn, routeAllowed: false })).toBe(false);
  });
});
