import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppConfig, type AppConfig } from './config.js';
import { createModelResolvers } from './modelResolvers.js';
import { assertAuxiliaryModelRefsResolvable } from './modelsHotUpdate.js';

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

  it('启动门禁拒绝悬空的辅助模型引用', () => {
    const config = parseAppConfig({
      agent: { cwd: '.' }, server: { port: 3200 },
      models: { groups: [GROUP], default: 'main/gpt' },
      guardrail: { model: 'removed/model' },
    });
    expect(() => assertAuxiliaryModelRefsResolvable(config, config.models!))
      .toThrow(/guardrail model chain cannot be resolved/u);
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
      getGuardrailModelConfigs: () => [],
      prepareSystemPromptOverridesUpdate: () => () => {},
      validateConfigReload: async () => {},
    });

    expect(modelResolver?.('main/gpt')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modelResolver?.('main/gpt')).toMatchObject({ model: 'gpt-test' });
  });

  it('跨进程修复悬空旧门禁引用时从已生效运行态回滚，不再重解旧配置', async () => {
    const stale = parseAppConfig({
      agent: { cwd: '.' }, server: { port: 3200 },
      models: { groups: [GROUP], default: 'main/gpt' },
      guardrail: { model: 'removed/model' },
    });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(stale));
    let guardrails = [{ model: 'startup-effective' }] as Array<{ model: string }>;
    const { sharedConfigRefresher } = createModelResolvers({
      config: structuredClone(stale),
      processCwd: dir,
      logger: { info: () => {}, warn: () => {} },
      titleGeneratorConfigs: [],
      onGuardrailModelConfigsUpdated: (next) => { guardrails = next; },
      getGuardrailModelConfigs: () => guardrails,
      prepareSystemPromptOverridesUpdate: () => () => {},
    });
    expect(await sharedConfigRefresher.refreshIfChanged(true)).toBe(true);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      agent: stale.agent, server: stale.server, models: stale.models,
    }));

    expect(await sharedConfigRefresher.refreshIfChanged(true)).toBe(true);
    expect(guardrails).toEqual([]);
  });
});
