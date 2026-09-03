import { describe, expect, it, vi } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';
import {
  BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
  BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION,
} from './sandboxState.js';
import { activeInvocationLeaseAnnotationKey } from './sandboxLifecyclePolicy.js';
import { LAST_ACTIVE_AT_ANNOTATION } from './sandboxInventoryReader.js';

const ok = (): KubectlResult => ({ stdout: '', stderr: '', exitCode: 0, signal: null });

describe('Sandbox invocation completion and background protection mutation fence', () => {
  it('rejects a new lease after Kubernetes accepted deletion', async () => {
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: {
        metadata: {
          uid: 'uid-deleting', resourceVersion: 'rv-deleting',
          deletionTimestamp: new Date().toISOString(), annotations: {},
        },
      },
    });

    await expect(manager.setActiveInvocationLease(
      'as-deleting', 'inv-after-delete', new Date(Date.now() + 60_000).toISOString(),
    )).rejects.toThrow(/已进入删除流程/u);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects late background protection after Kubernetes accepted deletion', async () => {
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: {
        metadata: {
          uid: 'uid-deleting', resourceVersion: 'rv-deleting',
          deletionTimestamp: new Date().toISOString(), annotations: {},
        },
      },
    });

    await expect(manager.setBackgroundShellProtection(
      'as-deleting', new Date(Date.now() + 60_000).toISOString(),
    )).rejects.toThrow(/已进入删除流程/u);
    expect(run).not.toHaveBeenCalled();
  });

  it('atomically advances activity generation and clears stale terminal state with the initial invocation lease', async () => {
    const run = vi.fn(async (_args: string[]) => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({ phase: 'Running', raw: { metadata: {
      uid: 'uid-1', resourceVersion: 'rv-1', annotations: {
        'agent-saas.kaiyan.net/terminal-state': 'completed',
        'agent-saas.kaiyan.net/terminal-at': '2026-08-30T00:00:00.000Z',
      },
    } } });

    await manager.setActiveInvocationLease(
      'as-active', 'inv-new', '2026-08-30T00:10:00.000Z', undefined, 'activity-new',
    );
    const patchArgs = (run.mock.calls as unknown[][])[0]![0] as string[];
    const patch = JSON.parse(patchArgs[4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(patch).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'add', path: expect.stringContaining('activity-generation'), value: 'activity-new' }),
      expect.objectContaining({ op: 'add', value: JSON.stringify({
        invocationKey: 'inv-new', until: '2026-08-30T00:10:00.000Z', state: 'executing',
      }) }),
      expect.objectContaining({ op: 'remove', path: expect.stringContaining('terminal-state') }),
      expect.objectContaining({ op: 'remove', path: expect.stringContaining('terminal-at') }),
    ]));
  });

  it('never shortens an invocation lease already extended for background fallback', async () => {
    const invocationKey = 'inv-background-fallback';
    const requested = '2026-08-30T00:05:00.000Z';
    const newer = '2026-08-30T00:10:00.000Z';
    const run = vi.fn(async (_args: string[]) => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: {
        metadata: {
          uid: 'uid-1', resourceVersion: 'rv-1',
          annotations: {
            [activeInvocationLeaseAnnotationKey(invocationKey)]: JSON.stringify({
              invocationKey, until: newer,
            }),
          },
        },
      },
    });

    await expect(manager.setActiveInvocationLease(
      'as-protected', invocationKey, requested,
    )).resolves.toBe('uid-1');
    const patchArgs = (run.mock.calls as unknown[][])[0]![0] as string[];
    const patch = JSON.parse(patchArgs[4]!) as Array<{ value?: unknown }>;
    expect(patch).toEqual(expect.arrayContaining([expect.objectContaining({
      value: JSON.stringify({ invocationKey, until: newer, state: 'executing' }),
    })]));
  });

  it('does not sweep expired background/completion pending leases and reports them busy', async () => {
    const executing = activeInvocationLeaseAnnotationKey('expired-executing');
    const background = activeInvocationLeaseAnnotationKey('pending-background');
    const completion = activeInvocationLeaseAnnotationKey('pending-completion');
    const annotations = {
      [executing]: JSON.stringify({ invocationKey: 'expired-executing', until: '2026-08-30T00:00:00.000Z', state: 'executing' }),
      [background]: JSON.stringify({ invocationKey: 'pending-background', until: '2026-08-30T00:00:00.000Z', state: 'background_pending' }),
      [completion]: JSON.stringify({ invocationKey: 'pending-completion', until: '2026-08-30T00:00:00.000Z', state: 'completion_pending', completedAt: '2026-08-29T23:59:00.000Z' }),
    };
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({ phase: 'Running', raw: { metadata: {
      uid: 'uid-1', resourceVersion: 'rv-1', annotations,
    } } });

    await expect(manager.clearExpiredInvocationLeases(
      'as-pending', new Date('2026-08-30T00:05:00.000Z'),
    )).resolves.toEqual({ active: true, removed: 1 });
    const patchArgs = (run.mock.calls as unknown[][])[0]![0] as string[];
    const patch = JSON.parse(patchArgs[4]!) as Array<{ path: string }>;
    expect(patch.some((entry) => entry.path.includes(executing.replaceAll('/', '~1')))).toBe(true);
    expect(patch.some((entry) => entry.path.includes(background.replaceAll('/', '~1')))).toBe(false);
    expect(patch.some((entry) => entry.path.includes(completion.replaceAll('/', '~1')))).toBe(false);
  });

  it('batch-sweeps expired invocation leases with UID/resourceVersion conflict retry', async () => {
    const expiredA = activeInvocationLeaseAnnotationKey('expired-a');
    const expiredB = activeInvocationLeaseAnnotationKey('expired-b');
    const active = activeInvocationLeaseAnnotationKey('active');
    const annotations = {
      [expiredA]: JSON.stringify({ invocationKey: 'expired-a', until: '2026-08-30T00:00:00.000Z' }),
      [expiredB]: '{malformed',
      [active]: JSON.stringify({ invocationKey: 'active', until: '2026-08-30T00:10:00.000Z' }),
    };
    const run = vi.fn()
      .mockResolvedValueOnce({
        stdout: '', stderr: 'Operation cannot be fulfilled: object has been modified', exitCode: 1, signal: null,
      } satisfies KubectlResult)
      .mockResolvedValueOnce(ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    const getStatus = vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce({ phase: 'Running', raw: { metadata: {
        uid: 'uid-1', resourceVersion: 'rv-1', annotations,
      } } })
      .mockResolvedValueOnce({ phase: 'Running', raw: { metadata: {
        uid: 'uid-1', resourceVersion: 'rv-2', annotations,
      } } })
      .mockResolvedValueOnce({ phase: 'Running', raw: { metadata: {
        uid: 'uid-1', resourceVersion: 'rv-3', annotations: { [active]: annotations[active] },
      } } });

    await expect(manager.clearExpiredInvocationLeases(
      'as-sweep', new Date('2026-08-30T00:05:00.000Z'),
    )).resolves.toEqual({ active: true, removed: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    const retryPatch = JSON.parse(run.mock.calls[1]![0][4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(run).toHaveBeenCalledTimes(2);
    expect(retryPatch).toEqual(expect.arrayContaining([
      { op: 'test', path: '/metadata/uid', value: 'uid-1' },
      { op: 'test', path: '/metadata/resourceVersion', value: 'rv-2' },
      { op: 'remove', path: expect.stringContaining(expiredA.replaceAll('/', '~1')) },
      { op: 'remove', path: expect.stringContaining(expiredB.replaceAll('/', '~1')) },
    ]));
    expect(retryPatch.some((entry) => entry.op === 'add')).toBe(false);

    await expect(manager.clearExpiredInvocationLeases(
      'as-sweep', new Date('2026-08-30T00:05:00.000Z'),
    )).resolves.toEqual({ active: true, removed: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('rejects protection writes and lease sweeps when the expected Sandbox UID was replaced', async () => {
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: { metadata: { uid: 'uid-new', resourceVersion: 'rv-new', annotations: {} } },
    });

    await expect(manager.setBackgroundShellProtection(
      'as-recreated', '2026-08-30T00:10:00.000Z', 'uid-old',
    )).rejects.toThrow(/同名重建/u);
    await expect(manager.setActiveInvocationLease(
      'as-recreated', 'inv-old', undefined, 'uid-old',
    )).rejects.toThrow(/同名重建/u);
    await expect(manager.clearExpiredInvocationLeases(
      'as-recreated', new Date('2026-08-30T00:05:00.000Z'), 'uid-old',
    )).rejects.toThrow(/同名重建/u);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not clear protection created after an empty runner snapshot was observed', async () => {
    const deadline = '2026-08-30T00:10:00.000Z';
    const staleGeneration = 'generation-old'; const concurrentGeneration = 'generation-new';
    const run = vi.fn(async (_args: string[]) => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-2', annotations: {
        [BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]: deadline,
        [BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION]: concurrentGeneration,
      } } },
    });

    await expect(manager.setBackgroundShellProtection(
      'as-protected', undefined, 'uid-1', staleGeneration,
    )).resolves.toBe('uid-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the generation bound to the later protection deadline during reverse-order writes', async () => {
    const laterDeadline = '2026-08-30T00:10:00.000Z';
    const run = vi.fn(async (_args: string[]) => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-2', annotations: {
        [BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]: laterDeadline,
        [BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION]: 'generation-later',
      } } },
    });

    await expect(manager.setBackgroundShellProtection(
      'as-protected', '2026-08-30T00:05:00.000Z', 'uid-1', undefined, 'generation-earlier',
    )).resolves.toBe('uid-1');

    expect(run).not.toHaveBeenCalled();
  });

  it('clears both background protection annotations only when the generation still matches', async () => {
    const observed = '2026-08-30T00:05:00.000Z'; const generation = 'generation-observed';
    const run = vi.fn(async (_args: string[]) => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-1', annotations: {
        [BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]: observed,
        [BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION]: generation,
      } } },
    });

    await expect(manager.setBackgroundShellProtection(
      'as-protected', undefined, 'uid-1', generation,
    )).resolves.toBe('uid-1');
    const patchArgs = (run.mock.calls as unknown[][])[0]![0] as string[];
    const patch = JSON.parse(patchArgs[4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(patch).toEqual(expect.arrayContaining([
      { op: 'test', path: expect.any(String), value: generation },
      { op: 'test', path: expect.any(String), value: observed },
      { op: 'remove', path: expect.any(String) },
    ]));
  });

  it('atomically removes only the completed lease and advances last-active on first completion', async () => {
    const completedAt = new Date('2026-09-02T04:00:00.000Z');
    const invocationKey = 'inv-complete';
    const leaseKey = activeInvocationLeaseAnnotationKey(invocationKey);
    const otherLeaseKey = activeInvocationLeaseAnnotationKey('inv-other');
    const lease = JSON.stringify({ invocationKey, until: '2026-09-02T04:05:00.000Z' });
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-1', annotations: {
        [leaseKey]: lease,
        [otherLeaseKey]: JSON.stringify({ invocationKey: 'inv-other', until: '2026-09-02T04:06:00.000Z' }),
        [LAST_ACTIVE_AT_ANNOTATION]: '2026-09-02T03:00:00.000Z',
      } } },
    });

    await expect(manager.completeInvocation(
      'as-complete', invocationKey, completedAt, 'uid-1',
    )).resolves.toBe('uid-1');
    const patchArgs = (run.mock.calls as unknown[][])[0]![0] as string[];
    const patch = JSON.parse(patchArgs[4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(patch).toEqual(expect.arrayContaining([
      { op: 'test', path: '/metadata/uid', value: 'uid-1' },
      { op: 'test', path: '/metadata/resourceVersion', value: 'rv-1' },
      { op: 'test', path: expect.stringContaining(leaseKey.replaceAll('/', '~1')), value: lease },
      { op: 'remove', path: expect.stringContaining(leaseKey.replaceAll('/', '~1')) },
      { op: 'add', path: expect.stringContaining(LAST_ACTIVE_AT_ANNOTATION.replaceAll('/', '~1')), value: completedAt.toISOString() },
    ]));
    expect(patch.some((entry) => entry.path.includes(otherLeaseKey.replaceAll('/', '~1')))).toBe(false);
  });

  it('accepts an ambiguous retry when the lease is gone and completedAt already persisted', async () => {
    const completedAt = new Date('2026-09-02T04:00:00.000Z');
    const run = vi.fn(async () => ok());
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus').mockResolvedValue({
      phase: 'Running',
      raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-2', annotations: {
        [LAST_ACTIVE_AT_ANNOTATION]: completedAt.toISOString(),
      } } },
    });

    await expect(manager.completeInvocation(
      'as-complete', 'inv-complete', completedAt, 'uid-1',
    )).resolves.toBe('uid-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('never moves last-active backward after a conflict reveals newer activity', async () => {
    const invocationKey = 'inv-late';
    const leaseKey = activeInvocationLeaseAnnotationKey(invocationKey);
    const lease = JSON.stringify({ invocationKey, until: '2026-09-02T05:05:00.000Z' });
    const newerActivity = '2026-09-02T05:00:00.000Z';
    const run = vi.fn(async () => ok()).mockResolvedValueOnce({
      stdout: '', stderr: 'Operation cannot be fulfilled: object has been modified', exitCode: 1, signal: null,
    });
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce({
        phase: 'Running', raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-1', annotations: {
          [leaseKey]: lease, [LAST_ACTIVE_AT_ANNOTATION]: '2026-09-02T03:00:00.000Z',
        } } },
      })
      .mockResolvedValueOnce({
        phase: 'Running', raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-2', annotations: {
          [leaseKey]: lease, [LAST_ACTIVE_AT_ANNOTATION]: newerActivity,
        } } },
      });

    await manager.completeInvocation(
      'as-complete', invocationKey, new Date('2026-09-02T04:00:00.000Z'), 'uid-1',
    );
    const retryArgs = (run.mock.calls as unknown[][])[1]![0] as string[];
    const retryPatch = JSON.parse(retryArgs[4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(retryPatch).toEqual(expect.arrayContaining([
      { op: 'add', path: expect.stringContaining(LAST_ACTIVE_AT_ANNOTATION.replaceAll('/', '~1')), value: newerActivity },
    ]));
  });

  it('rejects completion when a conflict reveals a same-name replacement', async () => {
    const invocationKey = 'inv-old';
    const leaseKey = activeInvocationLeaseAnnotationKey(invocationKey);
    const run = vi.fn(async () => ({
      stdout: '', stderr: 'jsonpatch test failed: object has been modified', exitCode: 1, signal: null,
    } satisfies KubectlResult));
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce({
        phase: 'Running',
        raw: { metadata: { uid: 'uid-old', resourceVersion: 'rv-old', annotations: {
          [leaseKey]: JSON.stringify({ invocationKey, until: '2026-09-02T04:05:00.000Z' }),
        } } },
      })
      .mockResolvedValueOnce({
        phase: 'Running', raw: { metadata: { uid: 'uid-new', resourceVersion: 'rv-new', annotations: {} } },
      });

    await expect(manager.completeInvocation(
      'as-replaced', invocationKey, new Date(), 'uid-old',
    )).rejects.toThrow(/同名重建/u);
    expect(run).toHaveBeenCalledOnce();
  });

  it('re-reads after a resourceVersion conflict and never shortens newer background protection', async () => {
    const requested = '2026-08-30T00:05:00.000Z';
    const newer = '2026-08-30T00:10:00.000Z';
    const run = vi.fn(async (_args: string[]) => ({
      stdout: '', stderr: 'Operation cannot be fulfilled: object has been modified', exitCode: 1, signal: null,
    } satisfies KubectlResult));
    const manager = new SandboxManager(baseConfig(), { run } as unknown as Kubectl, noopLogger);
    const getStatus = vi.spyOn(manager, 'getStatus')
      .mockResolvedValueOnce({
        phase: 'Running',
        raw: { metadata: { uid: 'uid-1', resourceVersion: 'rv-1', annotations: {} } },
      })
      .mockResolvedValueOnce({
        phase: 'Running',
        raw: {
          metadata: {
            uid: 'uid-1', resourceVersion: 'rv-2',
            annotations: { [BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]: newer },
          },
        },
      });

    await expect(manager.setBackgroundShellProtection('as-protected', requested)).resolves.toBe('uid-1');
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
    const patchArgs = (run.mock.calls as unknown[][])[0]![0] as string[];
    const patch = JSON.parse(patchArgs[4]!) as Array<{ op: string; path: string; value?: unknown }>;
    expect(patch).toEqual(expect.arrayContaining([
      { op: 'test', path: '/metadata/resourceVersion', value: 'rv-1' },
      expect.objectContaining({ value: requested }),
    ]));
  });
});
