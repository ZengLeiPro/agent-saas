import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContextCitationCard, contextCitationError, normalizeContextCitationDetail } from './ContextCitationCard';
import { safeContextCitationUrl } from './ContextCitationDrawer';
import { authFetch } from '@/lib/authFetch';

vi.mock('@/lib/authFetch', () => ({
  authFetch: vi.fn(),
  setOnUnauthorized: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

beforeEach(() => {
  authFetchMock.mockReset();
});

describe('ContextCitationCard', () => {
  it('使用可信 props 中的 sessionId/contextId 编码请求，并展示完整 Evidence', async () => {
    authFetchMock.mockResolvedValue(new Response(JSON.stringify({
      citation: {
        source: { displayName: '钉钉群聊', kind: 'dingtalk' },
        time: { occurredAt: '2026-08-22T12:30:00.000Z' },
        freshness: { status: 'fresh', asOf: '2026-08-22T12:31:00.000Z' },
        derived: true,
        evidence: [{
          excerpt: '客户要求周五前给出排期。',
          author: '林知远',
          url: 'https://example.com/native/42',
        }],
      },
      degraded: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    render(<ContextCitationCard sessionId="session/中文 1" contextId="ctx/原话 2" label="客户排期原话" />);
    fireEvent.click(screen.getByRole('button', { name: 'Context 引用：客户排期原话' }));

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith(
        '/api/sessions/session%2F%E4%B8%AD%E6%96%87%201/context-citations/ctx%2F%E5%8E%9F%E8%AF%9D%202',
        { method: 'GET' },
      );
    });
    expect(await screen.findByText('钉钉群聊')).toBeTruthy();
    expect(screen.getByText(/客户要求周五前给出排期/)).toBeTruthy();
    expect(screen.getByText(/林知远/)).toBeTruthy();
    expect(screen.getByText('派生证据')).toBeTruthy();
    expect(screen.getByText('降级结果')).toBeTruthy();
    const link = screen.getByRole('link', { name: /在原系统中打开/ });
    expect(link.getAttribute('href')).toBe('https://example.com/native/42');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('没有可信 sessionId 时保持禁用且不请求，分享页不会误用 marker 身份', () => {
    render(<ContextCitationCard contextId="ctx-1" label="内部上下文" />);
    const button = screen.getByRole('button', { name: 'Context 引用：内部上下文' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 503])('HTTP %s 显示明确错误', async (status) => {
    authFetchMock.mockResolvedValue(new Response(null, { status }));
    const view = render(<ContextCitationCard sessionId="session-1" contextId={`ctx-${status}`} label={`引用 ${status}`} />);
    fireEvent.click(screen.getByRole('button', { name: `Context 引用：引用 ${status}` }));
    expect(await screen.findByText(contextCitationError(status))).toBeTruthy();
    view.unmount();
  });
});

describe('Context citation 数据安全', () => {
  it('只允许原生 http(s) 链接', () => {
    expect(safeContextCitationUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeContextCitationUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(safeContextCitationUrl('javascript:alert(1)')).toBeNull();
    expect(safeContextCitationUrl('data:text/html,pwn')).toBeNull();
    expect(safeContextCitationUrl('//example.com/no-protocol')).toBeNull();
  });

  it('兼容扁平 evidence 与 data envelope', () => {
    expect(normalizeContextCitationDetail({
      data: {
        sourceName: '企业邮箱',
        sourceTime: '2026-08-22T01:00:00Z',
        freshness: 'aging',
        isDerived: false,
        isDegraded: false,
        quote: '邮件确认上线日期。',
        author: '王琳',
        originalUrl: 'https://mail.example.com/1',
      },
    })).toMatchObject({
      source: '企业邮箱',
      occurredAt: '2026-08-22T01:00:00Z',
      freshness: 'aging',
      derived: false,
      degraded: false,
      evidence: [{
        quote: '邮件确认上线日期。',
        author: '王琳',
        nativeUrl: 'https://mail.example.com/1',
      }],
    });
  });
});
