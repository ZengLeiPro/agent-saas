/**
 * 门禁申诉按钮测试（企业专家会话 chat bubble 申诉入口）
 *
 * 覆盖：
 *  A. Provider 缺省（个人 Agent 会话）→ 按钮零渲染（同 MessageFeedback 红线）
 *  B. 点击 → 弹层 → 可选理由 → POST /api/appeals → 「已申诉」态
 *  C. 幂等：同一 messageId 二次渲染仍为已申诉态；服务端 409 视为已申诉成功
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { GuardrailAppealButton, __resetSubmittedAppealsForTest } from './GuardrailAppealButton';
import { MessageFeedbackProvider } from '@/contexts/MessageFeedbackContext';

const authFetchMock = vi.fn();
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  setOnUnauthorized: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('GuardrailAppealButton', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    __resetSubmittedAppealsForTest();
  });

  it('A: 缺省 Provider（个人 Agent 会话）→ 按钮零渲染', () => {
    const { container } = render(
      <GuardrailAppealButton messageId="line-3" content="拒答话术" />,
    );
    expect(container.innerHTML).toBe('');
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('B: 点击 → 填理由 → POST /api/appeals → 显示已申诉徽标', async () => {
    // Provider 挂载时 GET feedback session（本用例无关，返 200 空即可）
    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    render(
      <MessageFeedbackProvider sessionId="22222222-2222-4222-8222-222222222222">
        <GuardrailAppealButton messageId="line-42" content="抱歉，我是报价审核助手，只处理报价单审核相关问题。" />
      </MessageFeedbackProvider>,
    );

    const btn = await screen.findByRole('button', { name: /申诉：/i });
    fireEvent.click(btn);

    const textarea = await screen.findByPlaceholderText('您认为为什么应该在范围内？（可选）');
    fireEvent.change(textarea, { target: { value: '这是审报价流程里的问题' } });

    authFetchMock.mockResolvedValueOnce(jsonResponse({ id: 'ap-xxx', status: 'pending' }));
    fireEvent.click(screen.getByRole('button', { name: '提交申诉' }));

    await waitFor(() => {
      const calls = authFetchMock.mock.calls;
      expect(calls.some(([url]) => url === '/api/appeals')).toBe(true);
    });
    const appealCall = authFetchMock.mock.calls.find(([url]) => url === '/api/appeals');
    expect(appealCall).toBeTruthy();
    const body = JSON.parse(String((appealCall![1] as RequestInit).body));
    expect(body).toMatchObject({
      guardrailEventId: 'line-42',
      appealReason: '这是审报价流程里的问题',
    });

    // 弹层关闭 + 已申诉徽标出现
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('您认为为什么应该在范围内？（可选）')).toBeNull();
    });
    expect(screen.getByRole('status').textContent).toContain('已申诉');
  });

  it('C: 服务端 409（同事件已申诉）→ 视为已申诉态', async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    render(
      <MessageFeedbackProvider sessionId="33333333-3333-4333-8333-333333333333">
        <GuardrailAppealButton messageId="ev-abc" content="拒答话术" />
      </MessageFeedbackProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /申诉：/i }));
    await screen.findByPlaceholderText('您认为为什么应该在范围内？（可选）');

    authFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'duplicate' }, 409));
    fireEvent.click(screen.getByRole('button', { name: '提交申诉' }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('您认为为什么应该在范围内？（可选）')).toBeNull();
    });
    expect(screen.getByRole('status').textContent).toContain('已申诉');
  });

  it('D: 服务端 500 → 显示错误、按钮不切已申诉态', async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    render(
      <MessageFeedbackProvider sessionId="44444444-4444-4444-8444-444444444444">
        <GuardrailAppealButton messageId="ev-err" content="拒答" />
      </MessageFeedbackProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /申诉：/i }));
    await screen.findByPlaceholderText('您认为为什么应该在范围内？（可选）');

    authFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'internal' }, 500));
    fireEvent.click(screen.getByRole('button', { name: '提交申诉' }));

    await waitFor(() => {
      expect(screen.getByText(/提交失败/)).toBeTruthy();
    });
    // 未切已申诉态：按钮仍在
    expect(screen.getByRole('button', { name: /申诉：/i })).toBeTruthy();
  });
});
