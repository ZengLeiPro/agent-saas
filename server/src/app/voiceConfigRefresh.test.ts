import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from './config.js';
import { createVoiceTranscriptionConfigRefresher } from './voiceConfigRefresh.js';
import type { SecretVault } from '../security/secretVault.js';

function configWithRefs(): AppConfig {
  return {
    agent: {},
    server: {},
    stt: {
      enabled: true,
      apiKeyRef: 'stt-api',
      ossAccessKeyIdRef: 'stt-oss-id',
      ossAccessKeySecretRef: 'stt-oss-secret',
    },
  } as AppConfig;
}

describe('Voice transcription config refresh', () => {
  it('每次先刷新文件并失效当前 STT refs，再原子提交重新解析的凭据', async () => {
    const order: string[] = [];
    const invalidate = vi.fn((ref: string) => order.push(`invalidate:${ref}`));
    const commit = vi.fn(() => order.push('commit'));
    const prepareSttUpdate = vi.fn(async () => {
      order.push('prepare');
      return commit;
    });
    const refresh = createVoiceTranscriptionConfigRefresher({
      config: configWithRefs(),
      secretVault: { invalidate } as unknown as SecretVault,
      refreshSharedConfig: async () => {
        order.push('shared');
        return true;
      },
      prepareSttUpdate,
    });

    await expect(refresh()).resolves.toBe(true);
    expect(order).toEqual([
      'shared',
      'invalidate:stt-api',
      'invalidate:stt-oss-id',
      'invalidate:stt-oss-secret',
      'prepare',
      'commit',
    ]);
    expect(prepareSttUpdate).toHaveBeenCalledWith(expect.objectContaining({ apiKeyRef: 'stt-api' }));
  });

  it('并发 Voice 请求串行刷新，较慢的旧解析不会晚于新请求提交', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPrepared = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    let prepareCalls = 0;
    const refreshSharedConfig = vi.fn(async () => {
      order.push(`shared:${refreshSharedConfig.mock.calls.length}`);
      return true;
    });
    const refresh = createVoiceTranscriptionConfigRefresher({
      config: configWithRefs(),
      secretVault: { invalidate: vi.fn() } as unknown as SecretVault,
      refreshSharedConfig,
      prepareSttUpdate: async () => {
        prepareCalls += 1;
        const call = prepareCalls;
        order.push(`prepare:${call}`);
        if (call === 1) await firstPrepared;
        return () => order.push(`commit:${call}`);
      },
    });

    const first = refresh();
    await vi.waitFor(() => expect(prepareCalls).toBe(1));
    const second = refresh();
    await Promise.resolve();
    expect(refreshSharedConfig).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order.indexOf('commit:1')).toBeLessThan(order.indexOf('shared:2'));
    expect(order.indexOf('commit:1')).toBeLessThan(order.indexOf('commit:2'));
  });

  it('共享配置刷新失败时不读取或提交 STT 凭据', async () => {
    const invalidate = vi.fn();
    const prepareSttUpdate = vi.fn();
    const refresh = createVoiceTranscriptionConfigRefresher({
      config: configWithRefs(),
      secretVault: { invalidate } as unknown as SecretVault,
      refreshSharedConfig: async () => false,
      prepareSttUpdate,
    });

    await expect(refresh()).resolves.toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    expect(prepareSttUpdate).not.toHaveBeenCalled();
  });

  it('管理端在解析期间更新 STT 时拒绝提交过期候选', async () => {
    const config = configWithRefs();
    const commit = vi.fn();
    const refresh = createVoiceTranscriptionConfigRefresher({
      config,
      secretVault: { invalidate: vi.fn() } as unknown as SecretVault,
      refreshSharedConfig: async () => true,
      prepareSttUpdate: async () => {
        config.stt = { ...config.stt, apiKeyRef: 'stt-api-new' } as AppConfig['stt'];
        return commit;
      },
    });

    await expect(refresh()).rejects.toThrow('STT 配置刷新已被更新版本取代');
    expect(commit).not.toHaveBeenCalled();
  });
});
