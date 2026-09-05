import { describe, expect, it } from 'vitest';
import { parsePushNotificationTarget } from './pushNotificationTarget';

describe('parsePushNotificationTarget', () => {
  it('把 /chat/<sessionId> 解析成会话目标', () => {
    expect(parsePushNotificationTarget({ url: '/chat/sess_123' })).toEqual({
      kind: 'session',
      sessionId: 'sess_123',
    });
  });

  it('对会话 id 做百分号解码', () => {
    expect(parsePushNotificationTarget({ url: '/chat/sess%20a' })).toEqual({
      kind: 'session',
      sessionId: 'sess a',
    });
  });

  it('把 /cron?jobId=&runId= 解析成任务目标，runId 可缺省', () => {
    expect(parsePushNotificationTarget({ url: '/cron?jobId=job_1&runId=run_9' })).toEqual({
      kind: 'cron',
      jobId: 'job_1',
      runId: 'run_9',
    });
    expect(parsePushNotificationTarget({ url: '/cron?jobId=job_1' })).toEqual({
      kind: 'cron',
      jobId: 'job_1',
    });
  });

  it('忽略 hash 与多余查询参数', () => {
    expect(parsePushNotificationTarget({ url: '/cron?jobId=job_1&foo=bar#top' })).toEqual({
      kind: 'cron',
      jobId: 'job_1',
    });
  });

  it('缺少 jobId 的 /cron 直接拒绝', () => {
    expect(parsePushNotificationTarget({ url: '/cron' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/cron?runId=run_9' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/cron?jobId=' })).toBeNull();
  });

  it('拒绝路径穿越、空段与含分隔符的标识符', () => {
    expect(parsePushNotificationTarget({ url: '/chat/..' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/chat/%2e%2e' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/chat/' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/chat//x' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/chat/a%2Fb' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/cron?jobId=%2e%2e%2fetc' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/chat/%E0%A4%A' })).toBeNull();
  });

  it('拒绝绝对 URL、协议相对 URL 与非站内路径', () => {
    expect(parsePushNotificationTarget({ url: 'https://evil.example/chat/x' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '//evil.example/chat/x' })).toBeNull();
    expect(parsePushNotificationTarget({ url: 'chat/x' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/taskboard' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/chat/a/b' })).toBeNull();
    expect(parsePushNotificationTarget({ url: '/cron/job_1' })).toBeNull();
  });

  it('payload 形状不符时 fail closed', () => {
    expect(parsePushNotificationTarget(null)).toBeNull();
    expect(parsePushNotificationTarget(undefined)).toBeNull();
    expect(parsePushNotificationTarget('/chat/x')).toBeNull();
    expect(parsePushNotificationTarget({})).toBeNull();
    expect(parsePushNotificationTarget({ url: 42 })).toBeNull();
  });
});
