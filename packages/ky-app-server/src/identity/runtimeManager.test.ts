import type { InstallationBinding } from '@kaiyan/ky-app-contract';
import { describe, expect, it, vi } from 'vitest';

import { MemoryInstallationBindingProvider } from './memory.js';
import { InstallationRuntimeManager } from './runtimeManager.js';

const value = (generation: number): InstallationBinding => ({
  installationId: 'inst-1',
  tenantId: 'tenant-1',
  systemId: 'system-1',
  deploymentId: 'deploy-1',
  origin: 'https://business.example.com',
  platformIssuer: 'https://platform.example.com',
  platformApiBaseUrl: 'https://api.example.com',
  keyId: `key-${generation}`,
  grantedScopes: ['directory.snapshot'],
  registeredDigest: 'a'.repeat(64),
  generation,
  state: 'activating',
  updatedAt: new Date(0).toISOString(),
});

describe('InstallationRuntimeManager', () => {
  it('零绑定时不启动 adapter，热接入不要求重启业务进程', async () => {
    const provider = new MemoryInstallationBindingProvider();
    const start = vi.fn();
    const manager = new InstallationRuntimeManager(provider, async () => ({
      validate: async () => undefined,
      start,
      drain: async () => undefined,
    }));
    expect(await provider.list()).toEqual([]);
    expect(manager.generation('inst-1')).toBeNull();
    await manager.install(value(1));
    expect(start).toHaveBeenCalledOnce();
    expect(manager.generation('inst-1')).toBe(1);
    expect((await provider.get('inst-1'))?.state).toBe('connected');
  });

  it('新 generation 校验失败时保留最后有效运行时', async () => {
    const provider = new MemoryInstallationBindingProvider();
    const oldDrain = vi.fn();
    const candidateDrain = vi.fn();
    const manager = new InstallationRuntimeManager(provider, async (binding) =>
      binding.generation === 1
        ? {
            validate: async () => undefined,
            start: async () => undefined,
            drain: async () => {
              oldDrain();
            },
          }
        : {
            validate: async () => {
              throw new Error('kms_unavailable');
            },
            start: async () => undefined,
            drain: async () => {
              candidateDrain();
            },
          },
    );
    await manager.install(value(1));
    await expect(manager.install(value(2))).rejects.toThrow('kms_unavailable');
    expect(manager.generation('inst-1')).toBe(1);
    expect((await provider.get('inst-1'))?.generation).toBe(1);
    expect(oldDrain).not.toHaveBeenCalled();
    expect(candidateDrain).toHaveBeenCalledOnce();
  });

  it('撤销会关闭 Agent 运行时但不操作独立业务数据', async () => {
    const provider = new MemoryInstallationBindingProvider();
    const drain = vi.fn();
    const manager = new InstallationRuntimeManager(provider, async () => ({
      validate: async () => undefined,
      start: async () => undefined,
      drain: async () => {
        drain();
      },
    }));
    await manager.install(value(1));
    await manager.revoke('inst-1', 1);
    expect(manager.generation('inst-1')).toBeNull();
    expect((await provider.get('inst-1'))?.state).toBe('revoked');
    expect(drain).toHaveBeenCalledOnce();
  });
});
