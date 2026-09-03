import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatSessionIndexItem } from '@/types/sidebar';
import { MobileSessionMetadata } from './MobileSessionMetadata';

const session: ChatSessionIndexItem = {
  id: 'session-1',
  title: '会话 A',
  createdAt: 1,
  updatedAt: 1,
  source: { type: 'web', label: 'WEB' },
};

describe('移动端会话元信息', () => {
  it('不显示默认的个人 Agent 标记', () => {
    render(
      <MobileSessionMetadata
        session={{
          ...session,
          agentTarget: { kind: 'personal', tenantId: 'tenant-1' },
        }}
        isAdmin={false}
      />,
    );

    expect(screen.getByText('WEB')).toBeTruthy();
    expect(screen.queryByText(/个人 Agent/)).toBeNull();
  });

  it('保留企业专家名称和不可验证状态', () => {
    const { rerender } = render(
      <MobileSessionMetadata
        session={{
          ...session,
          orgAgentName: '产品选型助手',
          agentTarget: { kind: 'org-agent', tenantId: 'tenant-1', orgAgentId: 'agent-1' },
        }}
        isAdmin={false}
      />,
    );

    expect(screen.getByText(/产品选型助手/)).toBeTruthy();

    rerender(<MobileSessionMetadata session={session} isAdmin={false} />);
    expect(screen.getByText(/绑定不可验证/)).toBeTruthy();
  });
});
