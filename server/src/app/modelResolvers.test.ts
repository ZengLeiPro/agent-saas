import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { createModelResolvers } from './modelResolvers.js';

const GROUP = {
  id: 'main',
  name: 'Main',
  baseUrl: 'https://example.invalid/v1',
  protocol: 'responses',
  apiKey: 'test-key',
  models: [{ id: 'gpt', name: 'GPT', value: 'gpt-test' }],
};

describe('createModelResolvers 异步配置刷新门禁', () => {
  let dir: string;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'model-resolvers-'));
    previousConfigPath = process.env.AGENT_SAAS_CONFIG_PATH;
    process.env.AGENT_SAAS_CONFIG_PATH = join(dir, 'config.json');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      agent: { cwd: '.' }, server: { port: 3200 },
      models: { groups: [GROUP], default: 'main/gpt' },
    }));
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.AGENT_SAAS_CONFIG_PATH;
    else process.env.AGENT_SAAS_CONFIG_PATH = previousConfigPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('异步配置提交期间同步模型解析 fail closed，提交后再开放', async () => {
    const config = { models: { groups: [GROUP], default: 'main/gpt' } } as unknown as AppConfig;
    const { modelResolver } = createModelResolvers({
      config,
      processCwd: dir,
      logger: { info: () => {}, warn: () => {} },
      titleGeneratorConfigs: [],
      onGuardrailModelConfigsUpdated: () => {},
      prepareSystemPromptOverridesUpdate: () => () => {},
      validateConfigReload: async () => {},
    });

    expect(modelResolver?.('main/gpt')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modelResolver?.('main/gpt')).toMatchObject({ model: 'gpt-test' });
  });
});
