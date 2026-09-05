import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeScenarioDeepLink,
  publishScenarioDeepLink,
  resetScenarioDeepLinkInbox,
} from './scenarioDeepLinkInbox';

describe('scenarioDeepLinkInbox', () => {
  beforeEach(() => resetScenarioDeepLinkInbox());

  it('投递后可被消费一次，第二次为空', () => {
    expect(publishScenarioDeepLink('agent-saas://chat?scenario=s1', { scenario: 's1' })).toEqual({
      kind: 'scenario',
      id: 's1',
      intent: 'view',
    });
    expect(consumeScenarioDeepLink()?.id).toBe('s1');
    expect(consumeScenarioDeepLink()).toBeNull();
  });

  it('同一条 URL 重复投递只接受一次（冷启动与 url 事件去重）', () => {
    const url = 'agent-saas://chat?workflow=w1&intent=run';
    expect(publishScenarioDeepLink(url, { workflow: 'w1', intent: 'run' })).not.toBeNull();
    consumeScenarioDeepLink();
    expect(publishScenarioDeepLink(url, { workflow: 'w1', intent: 'run' })).toBeNull();
    expect(consumeScenarioDeepLink()).toBeNull();
  });

  it('不带场景参数的 URL 不占用信箱', () => {
    expect(publishScenarioDeepLink('agent-saas://oauth/callback?code=x', { code: 'x' })).toBeNull();
    expect(consumeScenarioDeepLink()).toBeNull();
  });
});
