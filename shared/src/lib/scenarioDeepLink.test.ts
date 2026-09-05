import { describe, expect, it } from 'vitest';
import { parseScenarioDeepLink, stripScenarioDeepLinkParams } from './scenarioDeepLink';

describe('parseScenarioDeepLink', () => {
  it('workflow 优先于 scenario', () => {
    expect(parseScenarioDeepLink({ workflow: 'w1', scenario: 's1', intent: 'run' })).toEqual({
      kind: 'workflow',
      id: 'w1',
      intent: 'run',
    });
  });

  it('只有 scenario 时按 legacy 解析，intent 缺省为 view', () => {
    expect(parseScenarioDeepLink({ scenario: 's1' })).toEqual({
      kind: 'scenario',
      id: 's1',
      intent: 'view',
    });
  });

  it('非法 intent 归一成 view', () => {
    expect(parseScenarioDeepLink({ workflow: 'w1', intent: 'drop-tables' })?.intent).toBe('view');
  });

  it('expo-router 的数组参数取第一个值', () => {
    expect(parseScenarioDeepLink({ scenario: ['s1', 's2'] })?.id).toBe('s1');
    expect(parseScenarioDeepLink({ scenario: [] })).toBeNull();
  });

  it('无直达参数或空串时返回 null', () => {
    expect(parseScenarioDeepLink({})).toBeNull();
    expect(parseScenarioDeepLink({ scenario: '   ' })).toBeNull();
  });
});

describe('stripScenarioDeepLinkParams', () => {
  it('只清掉直达三件套，保留其余参数', () => {
    expect(
      stripScenarioDeepLinkParams({ workflow: 'w', scenario: 's', intent: 'run', keep: '1' }),
    ).toEqual({ keep: '1' });
  });
});
