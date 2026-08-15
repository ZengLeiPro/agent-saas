import { describe, expect, it, vi } from 'vitest';

import { resolveTitleGeneratorConfigs } from '../app/titleGeneratorConfigs.js';
import type { ModelsConfig } from '../app/config.js';

const models: ModelsConfig = {
  default: 'ark/glm',
  allowCrossGroupSwitch: true,
  groups: [{
    id: 'ark',
    name: 'Ark',
    apiKey: 'sk-test',
    baseUrl: 'https://example.invalid/v3',
    protocol: 'responses',
    models: [
      { id: 'glm', name: 'GLM', value: 'glm-5.2' },
      { id: 'deepseek', name: 'DeepSeek', value: 'deepseek-v4-flash' },
      { id: 'deepseek-alias', name: 'DeepSeek alias', value: 'deepseek-v4-flash' },
    ],
  }],
};

describe('resolveTitleGeneratorConfigs', () => {
  it('失效主引用不静默回退默认模型，继续使用有效 fallback', () => {
    const warn = vi.fn();
    const configs = resolveTitleGeneratorConfigs({
      models,
      titleGenerator: { model: 'removed/model', fallbackModels: ['ark/deepseek'] },
      logger: { info: vi.fn(), warn },
    });

    expect(configs).toEqual([{
      model: 'deepseek-v4-flash',
      modelRef: 'ark/deepseek',
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v3' },
      protocol: 'responses',
      providerOptions: expect.objectContaining({ protocol: 'responses' }),
    }]);
    expect(configs.some((config) => config.model === 'glm-5.2')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed/model'));
  });

  it('主备解析到同一端点和模型时去重', () => {
    const configs = resolveTitleGeneratorConfigs({
      models,
      titleGenerator: { model: 'ark/deepseek', fallbackModels: ['ark/deepseek-alias'] },
    });

    expect(configs).toHaveLength(1);
  });

  it('未配置专用链时保留环境默认模型兼容路径', () => {
    expect(resolveTitleGeneratorConfigs({ defaultModel: 'gpt-fallback' })).toEqual([{ model: 'gpt-fallback' }]);
  });
});
