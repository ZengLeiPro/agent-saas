import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumePushNotificationTarget,
  publishPushNotificationTarget,
  resetPushNotificationInbox,
} from './pushNotificationInbox';

describe('推送落地信箱', () => {
  beforeEach(() => {
    resetPushNotificationInbox();
  });

  it('接受可识别的落地路径并只消费一次', () => {
    expect(publishPushNotificationTarget('n1', { url: '/chat/s1' })).toEqual({
      kind: 'session',
      sessionId: 's1',
    });
    expect(consumePushNotificationTarget()).toEqual({ kind: 'session', sessionId: 's1' });
    expect(consumePushNotificationTarget()).toBeNull();
  });

  it('同一条通知重复投递只接受一次（冷启动与热态可能都投递）', () => {
    expect(publishPushNotificationTarget('n1', { url: '/chat/s1' })).not.toBeNull();
    expect(publishPushNotificationTarget('n1', { url: '/chat/s1' })).toBeNull();
    expect(consumePushNotificationTarget()).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('无法识别的 payload 不写入信箱，也不占用去重标记', () => {
    expect(publishPushNotificationTarget('n1', { url: '/taskboard' })).toBeNull();
    expect(consumePushNotificationTarget()).toBeNull();
    expect(publishPushNotificationTarget('n1', { url: '/cron?jobId=j1' })).toEqual({
      kind: 'cron',
      jobId: 'j1',
    });
  });

  it('后到的通知覆盖尚未消费的目标', () => {
    publishPushNotificationTarget('n1', { url: '/chat/s1' });
    publishPushNotificationTarget('n2', { url: '/cron?jobId=j1&runId=r1' });
    expect(consumePushNotificationTarget()).toEqual({ kind: 'cron', jobId: 'j1', runId: 'r1' });
  });

  it('reset 同时清空目标与去重标记', () => {
    publishPushNotificationTarget('n1', { url: '/chat/s1' });
    resetPushNotificationInbox();
    expect(consumePushNotificationTarget()).toBeNull();
    expect(publishPushNotificationTarget('n1', { url: '/chat/s1' })).not.toBeNull();
  });
});
