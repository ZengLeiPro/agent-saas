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
  it('不显示已确认的个人 Agent 标记', () => {
    render(
      <MobileSessionMetadata
        session={{
          ...session,
          agentTarget: { kind: 'personal', tenantId: 'tenant-1' },
          agentTargetSnapshot: { name: '个人 Agent', status: 'available', version: 1 },
        }}
        isAdmin={false}
      />,
    );
    expect(screen.getByText('WEB')).toBeTruthy();
    expect(screen.queryByText(/个人 Agent/)).toBeNull();
  });

  it('显示持久化的企业专家名称，不借用当前目录名称', () => {
    render(
      <MobileSessionMetadata
        session={{
          ...session,
          orgAgentName: '目录的新名字',
          agentTarget: { kind: 'org-agent', tenantId: 'tenant-1', orgAgentId: 'agent-1' },
          agentTargetSnapshot: { name: '产品选型助手', status: 'available', version: 1 },
        }}
        isAdmin={false}
      />,
    );
    expect(screen.getByText(/产品选型助手/)).toBeTruthy();
    expect(screen.queryByText(/目录的新名字/)).toBeNull();
  });

  it('新会话占位只显示同步中，服务端确认无绑定后才显示不可验证', () => {
    const { rerender } = render(<MobileSessionMetadata session={session} isAdmin={false} />);
    expect(screen.getByText(/身份同步中/)).toBeTruthy();
    expect(screen.queryByText(/绑定不可验证/)).toBeNull();
    rerender(<MobileSessionMetadata session={{
      ...session,
      agentTargetUnavailableReason: { code: 'legacy_binding_unproven', message: '历史会话仅支持查看', contactAdmin: true },
    }} isAdmin={false} />);
    expect(screen.getByText(/绑定不可验证/)).toBeTruthy();
  });
});
