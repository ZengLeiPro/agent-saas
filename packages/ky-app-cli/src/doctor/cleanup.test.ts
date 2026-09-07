import { describe, expect, it, vi } from 'vitest';
import type { DoctorContext } from './context.js';
import { cleanupTestExecutions } from './cleanup.js';

describe('doctor 测试清理边界', () => {
  function context(
    env = 'test',
    db = 'kyapp_doctor',
    result = { cleanupConfirmed: true, remaining: 0 },
  ) {
    const testHook = vi.fn().mockResolvedValue({ status: 200, json: { ok: true, result } });
    return {
      env: { KY_ENV: env, DATABASE_URL: `postgresql://localhost/${db}` },
      testHook,
    } as unknown as DoctorContext;
  }
  it.each(['staging', 'prod'])('%s 不发送清理请求', async (env) => {
    const ctx = context(env);
    await expect(cleanupTestExecutions(ctx, 'user.note.create', 'u', ['lc_1'])).rejects.toThrow();
    expect(ctx.testHook).not.toHaveBeenCalled();
  });
  it('非测试数据库不发送清理请求', async () => {
    const ctx = context('test', 'business');
    await expect(cleanupTestExecutions(ctx, 'user.note.create', 'u', ['lc_1'])).rejects.toThrow();
    expect(ctx.testHook).not.toHaveBeenCalled();
  });
  it('只发送确切能力、成员和本轮逻辑调用 ID', async () => {
    const ctx = context();
    await cleanupTestExecutions(ctx, 'user.note.create', 'u', ['lc_1']);
    expect(ctx.testHook).toHaveBeenCalledWith('provision', {
      cleanupExecutions: { capabilityId: 'user.note.create', sub: 'u', lcids: ['lc_1'] },
    });
  });
  it.each([
    { cleanupConfirmed: false, remaining: 0 },
    { cleanupConfirmed: true, remaining: 1 },
  ])('清理没有明确确认或仍有数据时失败', async (result) => {
    await expect(
      cleanupTestExecutions(context('test', 'kyapp_doctor', result), 'user.note.create', 'u', [
        'lc_1',
      ]),
    ).rejects.toThrow();
  });
});
