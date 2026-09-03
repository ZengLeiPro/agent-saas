import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));

const { startKbPreviewScheduler } = await import('./previewScheduler.js');

function fakeChild() {
  return { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
}

/**
 * 该任务在生产曾静默失败 52 天：release 只交付 prod 依赖，既无 pnpm workspace 根也无
 * devDependency tsx，`pnpm -F server run kb:previews` 每 15 分钟 exit 1。这里锁住
 * 「直接执行预编译 dist 入口」与「未 build 时跳过而非反复失败」两条。
 */
describe('KB preview scheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NODE_ENV = 'production';
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('直接执行预编译入口，不经过 pnpm / tsx', () => {
    existsSyncMock.mockReturnValue(true);
    const scheduler = startKbPreviewScheduler('/srv/app/server');
    vi.advanceTimersByTime(60_000);
    scheduler.stop();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0]!;
    const rendered = [command, ...(args as string[])].join(' ');
    expect(rendered).not.toContain('pnpm');
    expect(rendered).not.toContain('tsx');
    expect(args).toContain(process.execPath);
    expect(args).toContain('/srv/app/server/dist/jobs/kb-previews.mjs');
    expect(args).toContain('/srv/app/server/data/kb');
    // cwd 必须是 server 目录本身，不再是为 pnpm workspace 而上跳的父目录
    expect((options as { cwd: string }).cwd).toBe('/srv/app/server');
  });

  it('入口未 build 时跳过，不反复 spawn 失败', () => {
    existsSyncMock.mockReturnValue(false);
    const scheduler = startKbPreviewScheduler('/srv/app/server');
    vi.advanceTimersByTime(60_000 + 15 * 60_000 * 2);
    scheduler.stop();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('NODE_ENV=test 时完全不调度', () => {
    process.env.NODE_ENV = 'test';
    existsSyncMock.mockReturnValue(true);
    const scheduler = startKbPreviewScheduler('/srv/app/server');
    vi.advanceTimersByTime(60_000);
    scheduler.stop();

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
