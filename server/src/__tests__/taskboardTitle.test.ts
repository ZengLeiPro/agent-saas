import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateTitleWithFallback: vi.fn() }));

vi.mock('../agent/titleGenerator.js', () => ({
  generateTitleWithFallback: mocks.generateTitleWithFallback,
}));

import {
  createRuntimeTaskboardTitleGenerator,
  createTaskboardTitleGenerator,
} from '../taskboard/taskTitle.js';

const identity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user' as const,
};

const titleConfig = [{ model: 'title-model' }];

describe('任务看板标题生成', () => {
  it('复用平台标题模型配置和系统提示语', async () => {
    mocks.generateTitleWithFallback.mockResolvedValueOnce('自动生成标题');
    const generateTitle = createRuntimeTaskboardTitleGenerator('/agent', {
      titleGeneratorConfigs: titleConfig,
      refreshSharedConfig: vi.fn(),
      systemPromptRegistry: { get: vi.fn(() => '平台标题提示语') },
    });

    await expect(generateTitle('根据正文生成任务标题', identity)).resolves.toBe('自动生成标题');
    expect(mocks.generateTitleWithFallback).toHaveBeenCalledWith(
      '根据正文生成任务标题', '', titleConfig, undefined, undefined,
      expect.objectContaining({ systemPrompt: '平台标题提示语' }),
    );
  });

  it('模型或计费不可用时返回空标题', async () => {
    const generateTitle = createTaskboardTitleGenerator({
      agentCwd: '/agent',
      titleGeneratorConfigs: titleConfig,
      billingService: {
        beginUtilityModelRun: vi.fn().mockRejectedValue(new Error('余额不足')),
      } as never,
    });

    await expect(generateTitle('根据正文生成任务标题', identity)).resolves.toBeNull();
  });
});
