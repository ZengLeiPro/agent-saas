import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedConfigRefresher } from '../app/sharedConfigRefresher.js';
import { createSessionAutomationFlagSource } from '../app/sessionAutomationFlagSource.js';
import type { AppConfig } from '../app/config.js';

const BASE_GROUP = {
  id: 'ark-agents',
  name: '火山 Agent Plan',
  baseUrl: 'https://example.invalid/api/v3',
  protocol: 'responses',
  apiKey: 'sk-base-key',
  models: [{ id: 'glm-5.2', name: 'glm-5.2', value: 'glm-5.2' }],
};
const REPLACEMENT_GROUP = {
  ...BASE_GROUP,
  id: 'replacement',
  models: [{ id: 'new-model', name: 'new-model', value: 'new-model' }],
};

function writeConfig(dir: string, groups: unknown[]): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    agent: { cwd: '.' }, server: { port: 3200 },
    models: { groups, default: 'ark-agents/glm-5.2' },
  }, null, 2), 'utf-8');
}

describe('SharedConfigRefresher 删除、缺失与启动对齐语义', () => {
  let dir: string;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-config-removal-'));
    previousConfigPath = process.env.AGENT_SAAS_CONFIG_PATH;
    process.env.AGENT_SAAS_CONFIG_PATH = join(dir, 'config.json');
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.AGENT_SAAS_CONFIG_PATH;
    else process.env.AGENT_SAAS_CONFIG_PATH = previousConfigPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('首次磁盘快照缺失时返回 false，不把 undefined 当成已应用', () => {
    const config = { models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' } } as unknown as AppConfig;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => 10_000,
    });
    expect(refresher.refreshIfChanged(true)).toBe(false);
    expect(refresher.getAppliedStamps().config).toBeUndefined();
  });

  it('构造前磁盘已变化时首轮仍对齐，不把新指纹误认成内存基线', () => {
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
    } as unknown as AppConfig;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      agent: { cwd: '.' },
      server: { port: 3200 },
      models: { groups: [REPLACEMENT_GROUP], default: 'replacement/new-model' },
    }), 'utf-8');
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => 10_000,
    });

    expect(refresher.getAppliedStamps().config).toBeUndefined();
    expect(refresher.refreshIfChanged(true)).toBe(true);
    expect(config.models?.groups[0]?.id).toBe('replacement');
  });

  it('移除标题/门禁配置时清空旧链，并恢复启动阶段标题默认模型', () => {
    const initialRaw = {
      agent: { cwd: '.' },
      server: { port: 3200 },
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      titleGenerator: { model: 'ark-agents/glm-5.2', fallbackModels: [] },
      guardrail: { model: 'ark-agents/glm-5.2' },
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(initialRaw), 'utf-8');
    const config = structuredClone(initialRaw) as unknown as AppConfig;
    const titleConfigs: Array<{ model: string }> = [{ model: 'old-title' }];
    let guardrailConfigs: Array<{ model: string }> = [{ model: 'old-guardrail' }];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: {
        titleGeneratorConfigs: titleConfigs,
        defaultTitleModel: 'startup-default',
        updateGuardrailModelConfigs: (next) => { guardrailConfigs = next; },
      },
      now: () => clock,
    });

    const { titleGenerator: _title, guardrail: _guardrail, ...nextRaw } = initialRaw;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(nextRaw), 'utf-8');
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.titleGenerator).toBeUndefined();
    expect(config.guardrail).toBeUndefined();
    expect(titleConfigs).toEqual([{ model: 'startup-default' }]);
    expect(guardrailConfigs).toEqual([]);
  });

  it('模型更新使标题派生链失效时不推进执行侧、AppConfig 或文件指纹', () => {
    const initialRaw = {
      agent: { cwd: '.' },
      server: { port: 3200 },
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      titleGenerator: { model: 'ark-agents/glm-5.2', fallbackModels: [] },
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(initialRaw), 'utf-8');
    const config = structuredClone(initialRaw) as unknown as AppConfig;
    const titleConfigs: Array<{ model: string }> = [{ model: 'old-title' }];
    const warns: string[] = [];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: titleConfigs },
      logger: { info: () => {}, warn: (message) => warns.push(message) },
      now: () => clock,
    });
    const initialStamp = refresher.getAppliedStamps().config;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      ...initialRaw,
      models: { groups: [REPLACEMENT_GROUP], default: 'replacement/new-model' },
    }), 'utf-8');

    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.models?.groups[0]?.id).toBe('ark-agents');
    expect(titleConfigs).toEqual([{ model: 'old-title' }]);
    expect(refresher.getAppliedStamps().config).toEqual(initialStamp);
    expect(warns.some((message) => message.includes('title generator model chain cannot be resolved'))).toBe(true);
  });

  it('运行中移除 models 时 fail closed，不推进 AppConfig 或文件指纹', () => {
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
    } as unknown as AppConfig;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      agent: { cwd: '.' },
      server: { port: 3200 },
      models: config.models,
    }), 'utf-8');
    const warns: string[] = [];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      logger: { info: () => {}, warn: (message) => warns.push(message) },
      now: () => clock,
    });
    const initialStamp = refresher.getAppliedStamps().config;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      agent: { cwd: '.' },
      server: { port: 3200 },
    }), 'utf-8');

    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.models?.groups).toHaveLength(1);
    expect(refresher.getAppliedStamps().config).toEqual(initialStamp);
    expect(warns.some((message) => message.includes('移除 models 需要重启'))).toBe(true);
  });

  it('flag source 在无 model resolver 路径也会按 read 刷新 false -> true', () => {
    const writeWithAutomation = (executionEnabled?: boolean) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent: { cwd: '.' }, server: { port: 3200 },
        models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
        ...(executionEnabled === undefined ? {} : { sessionAutomation: {
          controlEnabled: true, executionEnabled, fixedLoopEnabled: true,
          adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
        } }),
      }, null, 2), 'utf-8');
    };
    writeWithAutomation(false);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      sessionAutomation: { controlEnabled: true, executionEnabled: false },
    } as unknown as AppConfig;
    const source = createSessionAutomationFlagSource(config);
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config, processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => clock,
    });
    source.attachRefresh(refresher.refreshIfChanged);

    expect(source.executionEnabled()).toBe(false);
    writeWithAutomation(true);
    clock += 5_000;
    expect(source.executionEnabled()).toBe(true);
    expect(source.read().fixedLoopEnabled).toBe(true);

    writeWithAutomation();
    clock += 5_000;
    expect(source.executionEnabled()).toBe(false);
    expect(source.read().controlEnabled).toBe(false);
  });

  it('首次 attach 会比对已加载内容，不把启动窗口内的新文件 stamp 当作基线', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      agent: { cwd: '.' }, server: { port: 3200 },
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      sessionAutomation: { controlEnabled: true, executionEnabled: false },
    }), 'utf-8');
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      sessionAutomation: { controlEnabled: true, executionEnabled: true },
    } as unknown as AppConfig;
    const source = createSessionAutomationFlagSource(config);
    const refresher = createSharedConfigRefresher({
      config, processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => 10_000,
    });

    source.attachRefresh(refresher.refreshIfChanged);
    expect(source.executionEnabled()).toBe(false);
    expect(refresher.getAppliedStamps().config).toBeDefined();
  });

  it('webTools 未变化时不触发执行侧更新', () => {
    writeConfig(dir, [BASE_GROUP]);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
    } as unknown as AppConfig;
    let calls = 0;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config, processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      prepareWebToolsUpdate: () => () => { calls += 1; },
      now: () => clock,
    });

    writeConfig(dir, [BASE_GROUP, REPLACEMENT_GROUP]);
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.models!.groups.map((group) => group.id)).toContain('replacement');
    expect(calls).toBe(0);
  });
});
