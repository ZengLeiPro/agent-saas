/**
 * §5.4 `agent.open` 落地：切 Agent 标签 + 只预填，**没有发送出口**。
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { requestAgentOpen, resetAgentOpenBus } from '@/lib/agentOpenBus';
import { useAgentOpenPrefill } from './useAgentOpenPrefill';
import prefillSource from './useAgentOpenPrefill.ts?raw';

afterEach(() => {
  resetAgentOpenBus();
});

function Harness({ log }: { log: string[] }) {
  useAgentOpenPrefill({
    setInput: (value) => log.push(`input:${value}`),
    setActiveTab: (tab) => log.push(`tab:${tab}`),
  });
  return null;
}

describe('useAgentOpenPrefill', () => {
  it('先切标签再预填', () => {
    const log: string[] = [];
    render(<Harness log={log} />);
    requestAgentOpen({ text: '来自《客户管理》\n催一下这单', installationId: 'inst-1' });
    expect(log).toEqual(['tab:chat', 'input:来自《客户管理》\n催一下这单']);
  });

  it('挂载前就发生的 agent.open 在挂载时补上（首屏停在定制软件标签的情形）', () => {
    requestAgentOpen({ text: '来自《客户管理》', installationId: 'inst-1' });
    const log: string[] = [];
    render(<Harness log={log} />);
    expect(log).toEqual(['tab:chat', 'input:来自《客户管理》']);
  });

  it('pending 只消费一次，第二个消费者不会重复拿到', () => {
    requestAgentOpen({ text: 'x', installationId: 'inst-1' });
    const first: string[] = [];
    const second: string[] = [];
    render(<Harness log={first} />);
    render(<Harness log={second} />);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
  });

  it('卸载后不再收到', () => {
    const log: string[] = [];
    const { unmount } = render(<Harness log={log} />);
    unmount();
    requestAgentOpen({ text: 'x', installationId: 'inst-1' });
    expect(log).toEqual([]);
  });

  it('源码里没有任何发送出口（只预填，不自动发送）', () => {
    for (const forbidden of ['sendMessage', 'sendChat', 'submit(', 'onSend']) {
      expect(prefillSource).not.toContain(forbidden);
    }
  });
});
