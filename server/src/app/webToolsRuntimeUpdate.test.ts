import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from './config.js';
import { createToolSettingsUpdater } from './webToolsRuntimeUpdate.js';

describe('webTools 运行时更新原子性', () => {
  it('凭据解析失败时管理端内存配置与执行侧 toolControls 都保留旧值', async () => {
    const oldToolControls = { WebSearch: { enabled: false } } as AppConfig['toolControls'];
    const nextToolControls = { WebSearch: { enabled: true } } as AppConfig['toolControls'];
    const config = {
      toolControls: oldToolControls,
      webTools: { search: { provider: 'tencent_wsa', apiKeyRef: 'old-ref' } },
    } as AppConfig;
    const target = { toolControls: oldToolControls };
    const applyWebTools = vi.fn(async () => {
      throw new Error('SecretVault resolve failed');
    });
    const update = createToolSettingsUpdater({ config, target, applyWebTools });

    await expect(
      update({
        toolControls: nextToolControls,
        webTools: { search: { provider: 'zhipu', apiKeyRef: 'new-ref' } },
      }),
    ).rejects.toThrow('SecretVault resolve failed');

    expect(config.toolControls).toBe(oldToolControls);
    expect(config.webTools?.search?.provider).toBe('tencent_wsa');
    expect(target.toolControls).toBe(oldToolControls);
  });
});
