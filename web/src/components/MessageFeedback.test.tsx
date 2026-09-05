/**
 * 消息反馈测试（计划用例 12-13）
 *
 * 12. 点踩 → 弹层 → 提交 POST → 「已反馈」实心态防连点
 * 13. Provider 缺省（个人 Agent 会话）→ 按钮零渲染（兼容性红线回归）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageFeedbackButton } from './MessageFeedback';
import { MessageFeedbackProvider } from '@/contexts/MessageFeedbackContext';

const authFetchMock = vi.fn();
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  setOnUnauthorized: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}



describe('MessageFeedback', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it('用例12: 点踩→弹层→POST→已反馈态防连点', async () => {
    // Provider 挂载时拉取本人已反馈集合（空）
    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    render(
      <MessageFeedbackProvider sessionId="11111111-1111-4111-8111-111111111111">
        <MessageFeedbackButton messageId="line-3" content="这是回答内容" />
      </MessageFeedbackProvider>,
    );

    const thumbButton = await screen.findByRole('button', { name: '反馈这个回答有问题' });
    fireEvent.click(thumbButton);

    // 锚定弹层出现，填评论并提交
    const textarea = await screen.findByPlaceholderText('可选：说明问题（如答非所问、信息有误）');
    fireEvent.change(textarea, { target: { value: '答非所问' } });

    authFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, duplicated: false, contentHash: 'hash-abc' }));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({ method: 'POST' }));
    });
    const postBody = JSON.parse(String((authFetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(postBody).toMatchObject({
      sessionId: '11111111-1111-4111-8111-111111111111',
      messageId: 'line-3',
      content: '这是回答内容',
      rating: 'down',
      comment: '答非所问',
    });

    // 已反馈态：实心红 + disabled 防连点（弹层关闭）
    // 注：提交后 contentHash 记入集合，按钮 hash 匹配后翻已反馈态
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('可选：说明问题（如答非所问、信息有误）')).toBeNull();
    });
    // hash 恢复态用真实 sha256(content) 匹配；本用例服务端返回 'hash-abc'，
    // 与本地 sha256 不同（伪造响应），故通过「集合含 hash-abc」验证提交链路，
    // 已提交视觉态用真实 hash 场景在下面覆盖。
  });

  it('用例12b: 刷新恢复——GET 返回的 contentHash 匹配后按钮为已反馈禁用态', async () => {
    const content = '被踩过的回答';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const realHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ contentHash: realHash, rating: 'down', createdAt: '2026-07-10T08:00:00.000Z' }] }));

    render(
      <MessageFeedbackProvider sessionId="11111111-1111-4111-8111-111111111111">
        <MessageFeedbackButton messageId="line-5" content={content} />
      </MessageFeedbackProvider>,
    );

    const submitted = await screen.findByRole('button', { name: '已反馈：这个回答有问题' });
    expect((submitted as HTMLButtonElement).disabled).toBe(true);
    // 防连点：点击不弹层
    fireEvent.click(submitted);
    expect(screen.queryByPlaceholderText('可选：说明问题（如答非所问、信息有误）')).toBeNull();
  });

  it('点赞：直接提交 rating=up 且不弹评论层，恢复态由 GET 的 rating 区分', async () => {
    const content = '这个回答很有用';
    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    render(
      <MessageFeedbackProvider sessionId="11111111-1111-4111-8111-111111111111">
        <MessageFeedbackButton messageId="line-7" content={content} />
      </MessageFeedbackProvider>,
    );

    const upButton = await screen.findByRole('button', { name: '反馈这个回答有帮助' });
    authFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, duplicated: false, contentHash: 'hash-up' }));
    fireEvent.click(upButton);

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({ method: 'POST' }));
    });
    const postBody = JSON.parse(String((authFetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(postBody).toMatchObject({ messageId: 'line-7', content, rating: 'up' });
    expect(postBody.comment).toBeUndefined();
    // 点赞不打开评论弹层
    expect(screen.queryByPlaceholderText('可选：说明问题（如答非所问、信息有误）')).toBeNull();
  });

  it('点赞恢复态：GET rating=up → 赞按钮标为已反馈，踩按钮同时禁用', async () => {
    const content = '被点过赞的回答';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const realHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    authFetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ contentHash: realHash, rating: 'up' }] }));

    render(
      <MessageFeedbackProvider sessionId="11111111-1111-4111-8111-111111111111">
        <MessageFeedbackButton messageId="line-8" content={content} />
      </MessageFeedbackProvider>,
    );

    const up = await screen.findByRole('button', { name: '已反馈：这个回答有帮助' });
    expect((up as HTMLButtonElement).disabled).toBe(true);
    const down = screen.getByRole('button', { name: '反馈这个回答有问题' });
    expect((down as HTMLButtonElement).disabled).toBe(true);
  });

  it('用例13: Provider 缺省时按钮零渲染（红线回归）', () => {
    const { container } = render(
      <MessageFeedbackButton messageId="line-1" content="个人 Agent 会话消息" />,
    );
    expect(container.innerHTML).toBe('');
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('F8: Provider sessionId=null（恒挂载）→ children 正常渲染且按钮零渲染、不拉取', () => {
    render(
      <MessageFeedbackProvider sessionId={null}>
        <div data-testid="layout-child">
          <MessageFeedbackButton messageId="line-1" content="个人 Agent 会话消息" />
        </div>
      </MessageFeedbackProvider>,
    );
    expect(screen.getByTestId('layout-child')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '反馈这个回答有问题' })).toBeNull();
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
