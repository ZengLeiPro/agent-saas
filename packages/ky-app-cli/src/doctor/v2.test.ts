import { describe, expect, it, vi } from 'vitest';

import { probeV2Adapter } from './v2.js';

describe('probeV2Adapter', () => {
  it('验证 live 与全部未授权拒绝面', async () => {
    const statuses = [200, 401, 400, 404];
    const request = vi.fn(async () => new Response('{}', { status: statuses.shift() }));
    const checks = await probeV2Adapter('https://business.example.com/', request as typeof fetch);
    expect(checks).toHaveLength(4);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });
});
