import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_TABS,
  capabilityTabContent,
  capabilityTabsFor,
  defaultCapabilityTab,
  normalizeCapabilityTab,
} from './capabilityTabs';

describe('能力中心 Tab 判定', () => {
  it('Tab 顺序与文案对齐 Web CAPABILITY_TABS', () => {
    expect(CAPABILITY_TABS.map((tab) => tab.value)).toEqual([
      'workflows',
      'skills',
      'connectors',
      'experts',
    ]);
    expect(CAPABILITY_TABS.map((tab) => tab.label)).toEqual(['工作流', '技能', '连接器', '专家']);
    for (const tab of CAPABILITY_TABS) {
      expect(tab.route).toBe(`/capabilities/${tab.value}`);
    }
  });

  it('未开放个人通用 Agent 时隐藏工作流 Tab', () => {
    expect(capabilityTabsFor(true)).toHaveLength(4);
    expect(capabilityTabsFor(false).map((tab) => tab.value)).toEqual([
      'skills',
      'connectors',
      'experts',
    ]);
  });

  it('默认 Tab 随租户形态切换', () => {
    expect(defaultCapabilityTab(true)).toBe('workflows');
    expect(defaultCapabilityTab(false)).toBe('experts');
  });

  it('归一化：非法值与被隐藏的 Tab 回落默认值', () => {
    expect(normalizeCapabilityTab('connectors', true)).toBe('connectors');
    expect(normalizeCapabilityTab('workflows', true)).toBe('workflows');
    expect(normalizeCapabilityTab('workflows', false)).toBe('experts');
    expect(normalizeCapabilityTab(undefined, true)).toBe('workflows');
    expect(normalizeCapabilityTab('templates', true)).toBe('workflows');
    expect(normalizeCapabilityTab(null, false)).toBe('experts');
  });

  it('内容形态与 Web TabsContent 分支一致', () => {
    for (const tab of CAPABILITY_TABS) {
      expect(capabilityTabContent(tab.value, true)).toBe('catalog');
    }
    expect(capabilityTabContent('workflows', false)).toBe('hidden');
    expect(capabilityTabContent('skills', false)).toBe('managed-notice');
    // 内置协同办公连接跟随用户 workspace，未开放个人 Agent 也必须留入口
    expect(capabilityTabContent('connectors', false)).toBe('built-in-only');
    expect(capabilityTabContent('experts', false)).toBe('catalog');
  });
});
