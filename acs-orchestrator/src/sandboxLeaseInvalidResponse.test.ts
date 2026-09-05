import { describe, expect, it, vi } from 'vitest';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

const invalid: KubectlResult = {
  stdout: '',
  stderr: 'The request is invalid: the server rejected our request due to an error in our request',
  exitCode: 1,
  signal: null,
};
const ok: KubectlResult = { stdout: '', stderr: '', exitCode: 0, signal: null };
const status = (resourceVersion: string, uid = 'uid') => ({
  phase: 'Running' as const,
  raw: { metadata: { uid, resourceVersion, annotations: {} } },
});

describe('租约通用 Invalid 响应回读', () => {
  it('独立回读证实 resourceVersion 竞争后重试，第二次仍带 UID/RV fence', async () => {
    const run = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue(ok);
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce(status('1'))
      .mockResolvedValue(status('2'));
    await expect(
      manager.setActiveInvocationLease('sandbox', 'invocation', '2026-09-07T00:00:00Z'),
    ).resolves.toBe('uid');
    expect(run).toHaveBeenCalledTimes(2);
    const patch = JSON.parse(run.mock.calls[1]![0][4]);
    expect(patch.slice(0, 2)).toEqual([
      { op: 'test', path: '/metadata/uid', value: 'uid' },
      { op: 'test', path: '/metadata/resourceVersion', value: '2' },
    ]);
  });
  it('同版本无效请求不重试', async () => {
    const run = vi.fn().mockResolvedValue(invalid);
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue(status('1'));
    await expect(
      manager.setActiveInvocationLease('sandbox', 'invocation', '2026-09-07T00:00:00Z'),
    ).rejects.toThrow('request is invalid');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('同名重建不能把旧 invocation 租约写到新 Sandbox', async () => {
    const run = vi.fn().mockResolvedValue(invalid);
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce(status('1'))
      .mockResolvedValue(status('2', 'new-uid'));
    await expect(
      manager.setActiveInvocationLease('sandbox', 'invocation', '2026-09-07T00:00:00Z'),
    ).rejects.toThrow('同名重建');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
