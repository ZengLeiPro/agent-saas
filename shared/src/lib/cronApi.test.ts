import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('./authFetch', () => ({ authFetch: api.authFetch }));

import {
  CRON_API_BASE,
  createCronJob,
  deleteCronJob,
  fetchCronDingtalkSessions,
  fetchCronJobs,
  fetchCronRunHistory,
  fetchCronServiceStatus,
  newCronRequestId,
  runCronJob,
  updateCronJob,
  validateCronExpression,
} from './cronApi';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function lastCall(): [string, RequestInit | undefined] {
  return api.authFetch.mock.calls.at(-1) as [string, RequestInit | undefined];
}

describe('cronApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('列表带 includeDisabled 并按下次运行排序', async () => {
    api.authFetch.mockResolvedValue(
      jsonResponse({
        jobs: [
          { id: 'b', state: { nextRunAtMs: 200 } },
          { id: 'a', state: { nextRunAtMs: 100 } },
        ],
      }),
    );
    const jobs = await fetchCronJobs();
    expect(lastCall()[0]).toBe(`${CRON_API_BASE}/jobs?includeDisabled=true`);
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('列表缺 jobs 字段时返回空数组', async () => {
    api.authFetch.mockResolvedValue(jsonResponse({}));
    await expect(fetchCronJobs()).resolves.toEqual([]);
  });

  it('状态与运行历史命中各自端点', async () => {
    api.authFetch.mockResolvedValue(
      jsonResponse({ enabled: true, jobCount: 1, enabledJobCount: 1 }),
    );
    await fetchCronServiceStatus();
    expect(lastCall()[0]).toBe(`${CRON_API_BASE}/status`);

    api.authFetch.mockResolvedValue(jsonResponse({ entries: [{ runId: 'r1' }] }));
    const entries = await fetchCronRunHistory('job 1', 50);
    expect(lastCall()[0]).toBe(`${CRON_API_BASE}/jobs/job%201/runs?limit=50`);
    expect(entries).toHaveLength(1);
  });

  it('增删改用对应的 HTTP 方法与 JSON 头', async () => {
    api.authFetch.mockResolvedValue(jsonResponse({ ok: true }));
    await createCronJob({
      name: 'n',
      schedule: { kind: 'every', everyMs: 60000 },
      payload: { kind: 'systemEvent', text: 't' },
    });
    expect(lastCall()[0]).toBe(`${CRON_API_BASE}/jobs`);
    expect(lastCall()[1]?.method).toBe('POST');

    await updateCronJob('id/1', { enabled: false });
    expect(lastCall()[0]).toBe(`${CRON_API_BASE}/jobs/id%2F1`);
    expect(lastCall()[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(lastCall()[1]?.body))).toEqual({ enabled: false });

    await deleteCronJob('id-2');
    expect(lastCall()[1]?.method).toBe('DELETE');
  });

  it('立即运行携带幂等键，且 header 与 body 的 requestId 一致', async () => {
    api.authFetch.mockResolvedValue(jsonResponse({ ok: true }));
    await runCronJob('job-1');
    const [url, init] = lastCall();
    expect(url).toBe(`${CRON_API_BASE}/jobs/job-1/run`);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(String(init?.body)).requestId).toBe(headers['Idempotency-Key']);
  });

  it('幂等键在缺少 crypto.randomUUID 时仍能生成且不重复', () => {
    vi.stubGlobal('crypto', {});
    try {
      const a = newCronRequestId();
      const b = newCronRequestId();
      expect(a).toMatch(/^cron-/);
      expect(a).not.toBe(b);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cron 校验：服务端非 2xx 视为非法，网络异常不误判为非法', async () => {
    api.authFetch.mockResolvedValue(jsonResponse({ error: 'bad expr' }, false, 400));
    await expect(validateCronExpression('nope')).resolves.toEqual({
      valid: false,
      error: 'bad expr',
    });

    api.authFetch.mockResolvedValue(jsonResponse({ valid: true }));
    await expect(validateCronExpression('0 9 * * *', 'UTC')).resolves.toEqual({ valid: true });
    expect(JSON.parse(String(lastCall()[1]?.body))).toEqual({ expr: '0 9 * * *', tz: 'UTC' });

    api.authFetch.mockRejectedValue(new Error('offline'));
    await expect(validateCronExpression('0 9 * * *')).resolves.toEqual({ valid: true });
  });

  it('钉钉会话列表缺字段时返回空数组', async () => {
    api.authFetch.mockResolvedValue(jsonResponse({}));
    await expect(fetchCronDingtalkSessions()).resolves.toEqual([]);
    expect(lastCall()[0]).toBe('/api/dingtalk/sessions');
  });
});
