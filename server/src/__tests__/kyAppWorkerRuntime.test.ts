import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRuntime } from '../app/runtime.js';
import { startKyAppWorkerRuntime } from '../app/kyAppWorkerRuntime.js';
import { buildKyAppAssembly } from '../kyapp/assembly.js';
import { loadKyAppConfig } from '../kyapp/config.js';

vi.mock('../kyapp/assembly.js', () => ({ buildKyAppAssembly: vi.fn() }));
vi.mock('../kyapp/config.js', () => ({ loadKyAppConfig: vi.fn() }));

beforeEach(() => vi.resetAllMocks());
const runtime = (processRole = 'runtime-worker') =>
  ({ processRole, processCwd: '/test' }) as AppRuntime;

describe('业务系统 headless Worker 启动', () => {
  it('独立 Worker 启动后台装配并注册退出清理', async () => {
    const start = vi.fn().mockResolvedValue(undefined),
      stop = vi.fn();
    const app = runtime();
    vi.mocked(loadKyAppConfig).mockReturnValue({} as never);
    vi.mocked(buildKyAppAssembly).mockReturnValue({ start, stop } as never);
    await startKyAppWorkerRuntime(app);
    expect(start).toHaveBeenCalledOnce();
    app.kyAppShutdown!();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(['ws-only', 'all', 'scheduler-only'])('%s 不重复启动 headless Worker', async (role) => {
    await startKyAppWorkerRuntime(runtime(role));
    expect(loadKyAppConfig).not.toHaveBeenCalled();
  });

  it('未配置业务接入时保持关闭', async () => {
    vi.mocked(loadKyAppConfig).mockReturnValue(null);
    await startKyAppWorkerRuntime(runtime());
    expect(buildKyAppAssembly).not.toHaveBeenCalled();
  });

  it('配置存在但权威依赖缺失时拒绝伪装启动成功', async () => {
    vi.mocked(loadKyAppConfig).mockReturnValue({} as never);
    vi.mocked(buildKyAppAssembly).mockReturnValue(null);
    await expect(startKyAppWorkerRuntime(runtime())).rejects.toThrow('authority unavailable');
  });

  it('启动失败时清理已装配任务并向上抛错', async () => {
    const stop = vi.fn();
    vi.mocked(loadKyAppConfig).mockReturnValue({} as never);
    vi.mocked(buildKyAppAssembly).mockReturnValue({
      start: vi.fn().mockRejectedValue(new Error('init failed')),
      stop,
    } as never);
    await expect(startKyAppWorkerRuntime(runtime())).rejects.toThrow('init failed');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('生产进程入口在 headless 早退之前启动，排空路径停止业务系统任务', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source.indexOf('await startKyAppWorkerRuntime(runtime)')).toBeLessThan(
      source.indexOf('HTTP/WebSocket listeners are disabled'),
    );
    expect(source.slice(source.indexOf('SIGUSR2 received'))).toContain(
      'runtime?.kyAppShutdown?.()',
    );
  });
});
