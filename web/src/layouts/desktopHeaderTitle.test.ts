import { describe, expect, it } from 'vitest';
import type { AgentTarget, OrgAgentSummary } from '@agent/shared';

import type { ChatSessionIndexItem } from '@/types/sidebar';

import { getDesktopHeaderTitle } from './desktopHeaderTitle';

const personalTarget: AgentTarget = { kind: 'personal', tenantId: 'tenant-1' };
const orgTarget: AgentTarget = { kind: 'org-agent', tenantId: 'tenant-1', orgAgentId: 'agent-1' };

function makeSession(overrides: Partial<ChatSessionIndexItem> = {}): ChatSessionIndexItem {
  return {
    id: 'session-1',
    title: '经营复盘准备',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const orgAgent: OrgAgentSummary = {
  id: 'agent-1',
  name: '经营分析专家',
  description: '',
  starterPrompts: [],
  skillCount: 0,
};

type Options = Parameters<typeof getDesktopHeaderTitle>[0];

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    activeTab: 'chat',
    isTrashPreview: false,
    sidebarSessions: [makeSession({ agentTarget: personalTarget })],
    sessionId: 'session-1',
    activeAgentTargetLabel: '个人 Agent',
    activeOrgAgent: null,
    orgAgentIdentityLoading: false,
    agentProfile: null,
    ...overrides,
  };
}

describe('getDesktopHeaderTitle', () => {
  it('个人 Agent 会话标题不追加「 · 个人 Agent」后缀', () => {
    expect(getDesktopHeaderTitle(makeOptions())).toBe('经营复盘准备');
  });

  it('个人 Agent 会话未命名时仍回退身份标签', () => {
    expect(
      getDesktopHeaderTitle(
        makeOptions({
          sidebarSessions: [makeSession({ title: '', agentTarget: personalTarget })],
        }),
      ),
    ).toBe('个人 Agent');
  });

  it('企业专家会话保留名称后缀', () => {
    expect(
      getDesktopHeaderTitle(
        makeOptions({
          sidebarSessions: [makeSession({ agentTarget: orgTarget, orgAgentName: '经营分析专家' })],
          activeAgentTargetLabel: '经营分析专家',
          activeOrgAgent: orgAgent,
        }),
      ),
    ).toBe('经营复盘准备 · 经营分析专家');
  });

  it('缺少持久化绑定的历史会话保留「绑定不可验证」状态后缀', () => {
    expect(
      getDesktopHeaderTitle(
        makeOptions({
          sidebarSessions: [makeSession({ agentTarget: undefined })],
          activeAgentTargetLabel: '绑定不可验证',
        }),
      ),
    ).toBe('经营复盘准备 · 绑定不可验证');
  });

  it('无会话标题时回退身份标签与默认名', () => {
    expect(getDesktopHeaderTitle(makeOptions({ sessionId: null }))).toBe('个人 Agent');
    expect(
      getDesktopHeaderTitle(makeOptions({ sessionId: null, activeAgentTargetLabel: undefined })),
    ).toBe('KY Agent');
  });

  it('Tab 标题不受会话后缀逻辑影响', () => {
    expect(getDesktopHeaderTitle(makeOptions({ activeTab: 'profile' }))).toBe('我的 Agent');
  });
});

describe('定制软件标签的标题（§6.6）', () => {
  it('拿到《系统名》就显示系统名，而不是静态「定制软件」', () => {
    expect(getDesktopHeaderTitle(makeOptions({ activeTab: 'apps', appsTitle: '客户管理' }))).toBe(
      '客户管理',
    );
  });

  it('系统停用 / 不再可见时显示「暂不可用」', () => {
    expect(getDesktopHeaderTitle(makeOptions({ activeTab: 'apps', appsTitle: '暂不可用' }))).toBe(
      '暂不可用',
    );
  });

  it('名字还没到位时用占位，绝不回落成上一段会话标题', () => {
    for (const appsTitle of [undefined, null, '']) {
      expect(getDesktopHeaderTitle(makeOptions({ activeTab: 'apps', appsTitle }))).toBe('定制软件');
    }
  });
});
