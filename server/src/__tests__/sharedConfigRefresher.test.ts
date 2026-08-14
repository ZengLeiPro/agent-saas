/**
 * 回归测试：跨进程配置刷新（2026-08-09 千问故障）。
 *
 * 复现的真实故障：平台管理页（ws-only 进程）往 config.json 新增了 qwen 模型组，
 * 但执行 run 的 runtime-worker 进程仍持有启动快照，模型解析拿不到 connection，
 * dispatch 报 "Raw runtime 缺少 OPENAI_API_KEY 或模型组 apiKey"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedConfigRefresher } from '../app/sharedConfigRefresher.js';
import type { AppConfig } from '../app/config.js';

const BASE_GROUP = {
  id: 'ark-agents',
  name: '火山 Agent Plan',
  baseUrl: 'https://example.invalid/api/v3',
  protocol: 'responses',
  apiKey: 'sk-base-key',
  models: [{ id: 'glm-5.2', name: 'glm-5.2', value: 'glm-5.2' }],
};

const QWEN_GROUP = {
  id: 'qwen',
  name: '千问 Plan',
  baseUrl: 'https://example.invalid/compatible-mode/v1',
  protocol: 'responses',
  apiKey: 'sk-qwen-key',
  models: [{ id: 'qwen38max', name: 'qwen3.8-max', value: 'qwen3.8-max' }],
};

function writeConfig(dir: string, groups: unknown[]): void {
  const cfg = {
    agent: { cwd: '.' },
    server: { port: 3200 },
    models: { groups, default: 'ark-agents/glm-5.2' },
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}

describe('createSharedConfigRefresher', () => {
  let dir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-config-refresher-'));
    prevEnv = process.env.AGENT_SAAS_CONFIG_PATH;
    process.env.AGENT_SAAS_CONFIG_PATH = join(dir, 'config.json');
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AGENT_SAAS_CONFIG_PATH;
    else process.env.AGENT_SAAS_CONFIG_PATH = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('把别的进程新增的模型组热更新进当前内存配置', () => {
    writeConfig(dir, [BASE_GROUP]);
    const config = { models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' } } as unknown as AppConfig;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => clock,
    });

    // 模拟 ws-only 进程写盘：新增 qwen 组
    writeConfig(dir, [BASE_GROUP, QWEN_GROUP]);
    clock += 5_000; // 越过节流窗口
    refresher.refreshIfChanged();

    const ids = config.models!.groups.map((g) => g.id);
    expect(ids).toContain('qwen');
    const qwen = config.models!.groups.find((g) => g.id === 'qwen');
    // 关键断言：apiKey 必须一并进来，否则 dispatch 仍会报缺少 apiKey
    expect(qwen?.apiKey).toBe('sk-qwen-key');
  });

  it('文件未变化时不重复解析（节流 + 指纹双重保护）', () => {
    writeConfig(dir, [BASE_GROUP]);
    const config = { models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' } } as unknown as AppConfig;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => clock,
    });

    const before = refresher.getAppliedStamps().config;
    clock += 5_000;
    refresher.refreshIfChanged();
    refresher.refreshIfChanged();
    expect(refresher.getAppliedStamps().config).toEqual(before);
    expect(config.models!.groups).toHaveLength(1);
  });

  it('config.json 写坏时保留当前内存配置，不把进程打挂', () => {
    writeConfig(dir, [BASE_GROUP, QWEN_GROUP]);
    const config = {
      models: { groups: [BASE_GROUP, QWEN_GROUP], default: 'ark-agents/glm-5.2' },
    } as unknown as AppConfig;
    let clock = 10_000;
    const warnings: string[] = [];
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
      now: () => clock,
    });

    writeFileSync(join(dir, 'config.json'), '{ 这不是合法 JSON', 'utf-8');
    clock += 5_000;
    expect(() => refresher.refreshIfChanged()).not.toThrow();
    expect(config.models!.groups).toHaveLength(2);
    expect(warnings.join('\n')).toContain('解析失败');

    // 修好之后应当能立刻被重新拾起（坏文件不能推进已应用指纹）
    writeConfig(dir, [BASE_GROUP]);
    clock += 5_000;
    refresher.refreshIfChanged();
    expect(config.models!.groups).toHaveLength(1);
  });

  it('热更新标题模型链与标题提示语覆盖', () => {
    const initialRaw = {
      agent: { cwd: '.' },
      server: { port: 3200 },
      models: { groups: [BASE_GROUP, QWEN_GROUP], default: 'ark-agents/glm-5.2' },
      titleGenerator: { model: 'ark-agents/glm-5.2', fallbackModels: [] },
      systemPrompts: { 'utility.title': '旧提示语' },
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(initialRaw, null, 2), 'utf-8');
    const config = structuredClone(initialRaw) as unknown as AppConfig;
    let clock = 10_000;
    const titleConfigs: Array<{ model: string }> = [];
    let promptOverrides: Record<string, string> = {};
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: {
        updateGuardrailModelConfigs: () => {},
        titleGeneratorConfigs: titleConfigs,
      },
      onSystemPromptOverridesUpdated: (next) => { promptOverrides = next; },
      now: () => clock,
    });

    const nextRaw = {
      ...initialRaw,
      titleGenerator: {
        model: 'qwen/qwen38max',
        fallbackModels: ['ark-agents/glm-5.2'],
      },
      systemPrompts: { 'utility.title': '新提示语' },
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(nextRaw, null, 2), 'utf-8');
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.titleGenerator).toEqual(nextRaw.titleGenerator);
    expect(titleConfigs.map((item) => item.model)).toEqual(['qwen3.8-max', 'glm-5.2']);
    expect(promptOverrides).toEqual({ 'utility.title': '新提示语' });
  });

  it('组织白名单变更后重载 tenantStore', () => {
    writeConfig(dir, [BASE_GROUP]);
    const tenantsPath = join(dir, 'tenants.json');
    writeFileSync(tenantsPath, JSON.stringify({ version: 1, tenants: [] }), 'utf-8');
    let reloaded = 0;
    const config = { models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' } } as unknown as AppConfig;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      tenantStore: { reload: () => { reloaded += 1; } } as never,
      tenantsFilePath: tenantsPath,
      now: () => clock,
    });

    clock += 5_000;
    refresher.refreshIfChanged();
    expect(reloaded).toBe(0); // 没变化不该重载

    writeFileSync(
      tenantsPath,
      JSON.stringify({ version: 1, tenants: [{ id: 'kaiyan', settings: {} }] }),
      'utf-8',
    );
    clock += 5_000;
    refresher.refreshIfChanged();
    expect(reloaded).toBe(1);
    // 确认读的就是这个文件，避免路径拼错却静默通过
    expect(readFileSync(tenantsPath, 'utf-8')).toContain('kaiyan');
  });
});
