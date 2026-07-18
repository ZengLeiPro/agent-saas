/**
 * parseJsonResponse.ts 测试
 *
 * 用全局 Response（undici）构造各种响应，验证：
 * - JSON 且 ok → 返回解析数据
 * - JSON 且非 ok，body 含 string error → 抛该 error
 * - JSON 且非 ok，无 error 字段 → 抛 "HTTP {status}"
 * - 非 JSON content-type → 抛带 feature/status 提示与响应片段的错误
 * - 各状态码走不同 hint 分支（404 / 502 / 500 / 其它）
 */
import { describe, expect, it } from 'vitest';
import { parseJsonResponse } from './parseJsonResponse';

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

describe('parseJsonResponse', () => {
  it('JSON + ok 时返回解析后的数据', async () => {
    const res = jsonResponse({ hello: 'world', n: 1 });
    await expect(parseJsonResponse<{ hello: string; n: number }>(res)).resolves.toEqual({ hello: 'world', n: 1 });
  });

  it('JSON 非 ok 且 body 含 string error 时抛出该 error', async () => {
    const res = jsonResponse({ error: '定时任务不存在' }, { status: 400 });
    await expect(parseJsonResponse(res)).rejects.toThrow('定时任务不存在');
  });

  it('JSON 非 ok 且无 error 字段时抛 "HTTP {status}"', async () => {
    const res = jsonResponse({ message: 'oops' }, { status: 403 });
    await expect(parseJsonResponse(res)).rejects.toThrow('HTTP 403');
  });

  it('JSON 非 ok 且 error 非字符串时回退 "HTTP {status}"', async () => {
    const res = jsonResponse({ error: { nested: true } }, { status: 500 });
    await expect(parseJsonResponse(res)).rejects.toThrow('HTTP 500');
  });

  it('非 JSON 响应抛错，含 feature 前缀、status 与响应片段', async () => {
    const res = htmlResponse('<!doctype html><html>index fallback</html>', 200);
    await expect(parseJsonResponse(res, '定时任务')).rejects.toThrow(/定时任务：/);
  });

  it('404 非 JSON 走「API 路由未挂载」提示分支', async () => {
    const res = htmlResponse('<html>not found</html>', 404);
    await expect(parseJsonResponse(res)).rejects.toThrow(/对应 API 路由未挂载/);
  });

  it('502/503/504 非 JSON 走「上游网关不可达」提示分支', async () => {
    for (const status of [502, 503, 504]) {
      const res = htmlResponse('<html>bad gateway</html>', status);
      await expect(parseJsonResponse(res)).rejects.toThrow(/上游网关或后端服务不可达/);
    }
  });

  it('500 非 JSON（非 502/503/504）走「服务端错误」提示分支', async () => {
    const res = htmlResponse('<html>err</html>', 500);
    await expect(parseJsonResponse(res)).rejects.toThrow(/服务端错误/);
  });

  it('非 JSON 但状态正常（无 hint）仍抛出含 HTTP 状态的错误', async () => {
    const res = htmlResponse('<html>ok page</html>', 200);
    const err = await parseJsonResponse(res).catch((e: Error) => e);
    expect((err as Error).message).toContain('收到非 JSON 响应（HTTP 200');
    expect((err as Error).message).toContain('响应片段：');
  });
});
