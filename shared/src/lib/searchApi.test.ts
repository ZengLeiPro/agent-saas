import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import { searchSessions } from './searchApi';

const mockAuthFetch = vi.mocked(authFetch);

// parseJsonResponse 依赖 content-type header + json()/text()
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

// 非 JSON 响应（SPA 兜底 / 网关错误页）
function htmlResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/html' }),
    json: vi.fn(),
    text: vi.fn().mockResolvedValue('<!doctype html><html></html>'),
  } as unknown as Response;
}

function lastUrl() {
  return mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1][0];
}

describe('searchApi.searchSessions', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  it('只有 q 时 query 只带 q', async () => {
    const body = { results: [], nextCursor: null };
    mockAuthFetch.mockResolvedValue(jsonResponse(200, body));

    await expect(searchSessions({ q: '你好' })).resolves.toEqual(body);
    expect(lastUrl()).toBe('/api/search/sessions?q=%E4%BD%A0%E5%A5%BD');
  });

  it('带 limit 和 cursor 时全部拼进 query', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
    await searchSessions({ q: 'hi', limit: 20, cursor: 'c1' });
    expect(lastUrl()).toBe('/api/search/sessions?q=hi&limit=20&cursor=c1');
  });

  it('limit=0 也应被拼入（!== undefined 判断）', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
    await searchSessions({ q: 'hi', limit: 0 });
    expect(lastUrl()).toBe('/api/search/sessions?q=hi&limit=0');
  });

  it('非 2xx JSON 且 body.error 时抛该 error', async () => {
    mockAuthFetch.mockResolvedValue(jsonResponse(400, { error: '搜索关键词不能为空' }));
    await expect(searchSessions({ q: '' })).rejects.toThrow('搜索关键词不能为空');
  });

  it('收到非 JSON 响应时抛带上下文的错误（含业务名「会话搜索」）', async () => {
    mockAuthFetch.mockResolvedValue(htmlResponse(404));
    await expect(searchSessions({ q: 'hi' })).rejects.toThrow('会话搜索');
  });
});
