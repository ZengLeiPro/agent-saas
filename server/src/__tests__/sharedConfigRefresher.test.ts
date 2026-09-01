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
import { createSessionAutomationFlagSource } from '../app/sessionAutomationFlagSource.js';
import type { AppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';

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

function writeConfig(
  dir: string,
  groups: unknown[],
  titleGenerator?: { model: string; fallbackModels?: string[] },
): void {
  const cfg = {
    agent: { cwd: '.' },
    server: { port: 3200 },
    models: { groups, default: 'ark-agents/glm-5.2' },
    ...(titleGenerator ? { titleGenerator } : {}),
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}

function writeCodexConfig(
  dir: string,
  codexSubscription: AppConfig['codexSubscription'],
  groups: unknown[] = [BASE_GROUP],
): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    agent: { cwd: '.' },
    server: { port: 3200 },
    models: { groups, default: 'ark-agents/glm-5.2' },
    ...(codexSubscription ? { codexSubscription } : {}),
  }, null, 2), 'utf-8');
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

  it('跨进程热更新完整 Codex 配置，并让同一个 CredentialManager 立即读取新账号顺序', () => {
    const initial = {
      enabled: true,
      websocketEnabled: true,
      credentialRef: 'credential-old-primary',
      credentialRefs: ['credential-old-primary', 'credential-old-secondary'],
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      originator: 'codex-tui',
    } satisfies NonNullable<AppConfig['codexSubscription']>;
    const replacement = {
      enabled: false,
      websocketEnabled: false,
      credentialRef: 'credential-new-primary',
      credentialRefs: ['credential-new-primary', 'credential-old-primary'],
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      originator: 'kaiyan-agent',
    } satisfies NonNullable<AppConfig['codexSubscription']>;
    writeCodexConfig(dir, initial);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      codexSubscription: structuredClone(initial),
    } as unknown as AppConfig;
    const manager = new CodexCredentialManager({
      vault: new InMemorySecretVault(),
      getConfig: () => config.codexSubscription,
    });
    const logs: string[] = [];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      logger: { info: (message) => logs.push(message), warn: () => {} },
      now: () => clock,
    });

    expect(manager.getCredentialRefs()).toEqual(initial.credentialRefs);
    writeCodexConfig(dir, replacement);
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.codexSubscription).toEqual(replacement);
    expect(config.codexSubscription?.credentialRef).toBe(replacement.credentialRefs[0]);
    expect(manager.getCredentialRefs()).toEqual(replacement.credentialRefs);
    expect(manager.getConfiguration()).toMatchObject({
      enabled: false,
      websocketEnabled: false,
      endpoint: replacement.endpoint,
      originator: replacement.originator,
    });
    expect(logs.filter((message) => message.includes('Codex 订阅配置'))).toEqual([
      '[SharedConfig] 已从磁盘热更新 Codex 订阅配置：enabled=false / websocketEnabled=false / credentialCount=2',
    ]);
    expect(logs.join('\n')).not.toContain('credential-new-primary');
  });

  it('同步 Codex 开关、账号删除与 section 清理，非相关配置变化不产生 Codex 副作用', () => {
    const initial = {
      enabled: true,
      websocketEnabled: true,
      credentialRef: 'credential-a',
      credentialRefs: ['credential-a', 'credential-b'],
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      originator: 'codex-tui',
    } satisfies NonNullable<AppConfig['codexSubscription']>;
    const disabled = {
      ...initial,
      enabled: false,
      websocketEnabled: false,
      credentialRef: 'credential-b',
      credentialRefs: ['credential-b'],
    } satisfies NonNullable<AppConfig['codexSubscription']>;
    writeCodexConfig(dir, initial);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      codexSubscription: structuredClone(initial),
    } as unknown as AppConfig;
    const logs: string[] = [];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      logger: { info: (message) => logs.push(message), warn: () => {} },
      now: () => clock,
    });

    writeCodexConfig(dir, disabled);
    clock += 5_000;
    refresher.refreshIfChanged();
    expect(config.codexSubscription).toEqual(disabled);
    expect(config.codexSubscription?.credentialRefs).not.toContain('credential-a');

    const reenabled = { ...disabled, enabled: true, websocketEnabled: true };
    writeCodexConfig(dir, reenabled);
    clock += 5_000;
    refresher.refreshIfChanged();
    expect(config.codexSubscription).toMatchObject({ enabled: true, websocketEnabled: true });

    const codexConfigAfterToggle = config.codexSubscription;
    const codexLogCountAfterToggle = logs.filter((message) => message.includes('Codex 订阅配置')).length;
    writeCodexConfig(dir, reenabled, [BASE_GROUP, QWEN_GROUP]);
    clock += 5_000;
    refresher.refreshIfChanged();
    refresher.refreshIfChanged();
    expect(config.codexSubscription).toBe(codexConfigAfterToggle);
    expect(logs.filter((message) => message.includes('Codex 订阅配置')))
      .toHaveLength(codexLogCountAfterToggle);

    writeCodexConfig(dir, undefined, [BASE_GROUP, QWEN_GROUP]);
    clock += 5_000;
    refresher.refreshIfChanged();
    expect(config.codexSubscription).toBeUndefined();
    expect(logs.at(-1)).toBe(
      '[SharedConfig] 已从磁盘热更新 Codex 订阅配置：enabled=false / websocketEnabled=false / credentialCount=0',
    );
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

    clock += 5_000;
    refresher.refreshIfChanged();
    const applied = refresher.getAppliedStamps().config;
    refresher.refreshIfChanged();
    expect(refresher.getAppliedStamps().config).toEqual(applied);
    expect(config.models!.groups).toHaveLength(1);
  });

  it('只修改标题模型引用时也热更新内存配置和运行链', () => {
    const groups = [BASE_GROUP, QWEN_GROUP];
    writeConfig(dir, groups, { model: 'ark-agents/glm-5.2' });
    const config = {
      models: { groups, default: 'ark-agents/glm-5.2' },
      titleGenerator: { model: 'ark-agents/glm-5.2' },
    } as unknown as AppConfig;
    const target = {
      updateGuardrailModelConfigs: () => {},
      titleGeneratorConfigs: [] as Array<{ model: string }>,
    };
    const originalTitleConfigs = target.titleGeneratorConfigs;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target,
      now: () => clock,
    });

    writeConfig(dir, groups, { model: 'qwen/qwen38max' });
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.titleGenerator?.model).toBe('qwen/qwen38max');
    expect(target.titleGeneratorConfigs).toBe(originalTitleConfigs);
    expect(target.titleGeneratorConfigs).toEqual([expect.objectContaining({
      model: 'qwen3.8-max',
      protocol: 'responses',
    })]);
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

  /**
   * 回归：2026-08-16 搜索源从腾讯换到智谱后，config.json 与 ws-only 进程都已是新配置，
   * 但 runtime-worker 仍用启动快照里的旧 provider，真实会话持续报旧供应商鉴权错误。
   */
  it('把别的进程改写的 webTools 热更新进当前内存配置并回调', () => {
    const writeWithWebTools = (provider: string) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent: { cwd: '.' },
        server: { port: 3200 },
        models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
        webTools: { enabled: true, search: { provider, apiKeyRef: `ref-${provider}`, maxResults: 8 } },
      }, null, 2), 'utf-8');
    };
    writeWithWebTools('tencent_wsa');
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      webTools: { enabled: true, search: { provider: 'tencent_wsa', apiKeyRef: 'ref-tencent_wsa', maxResults: 8 } },
    } as unknown as AppConfig;
    const seen: Array<string | undefined> = [];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      onWebToolsUpdated: (next) => { seen.push(next?.search?.provider); },
      now: () => clock,
    });

    writeWithWebTools('zhipu');
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.webTools?.search?.provider).toBe('zhipu');
    // 关键断言：回调必须触发，执行侧才有机会重新解析凭据并替换运行时配置
    expect(seen).toEqual(['zhipu']);
  });

  it('把别的进程改写或清除的 toolControls 热更新进当前内存配置', () => {
    const writeWithToolControls = (toolControls?: AppConfig['toolControls']) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent: { cwd: '.' },
        server: { port: 3200 },
        models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
        ...(toolControls ? { toolControls } : {}),
      }, null, 2), 'utf-8');
    };
    const initial = { tools: { Write: { enabled: false } } } satisfies NonNullable<AppConfig['toolControls']>;
    const replacement = {
      tools: {
        Write: {
          descriptionOverride: { mode: 'replace' as const, text: '只写入管理员批准的交付文件。' },
        },
      },
    } satisfies NonNullable<AppConfig['toolControls']>;
    writeWithToolControls(initial);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      toolControls: initial,
    } as unknown as AppConfig;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => clock,
    });

    writeWithToolControls(replacement);
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.toolControls).toEqual(replacement);

    writeWithToolControls();
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.toolControls).toBeUndefined();
  });

  it('把别的进程改写的 STT 配置热更新进当前内存并通知执行侧', () => {
    const writeWithStt = (enabled: boolean, creditsPerCall: number) => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        agent: { cwd: '.' },
        server: { port: 3200 },
        models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
        stt: {
          enabled,
          apiKeyRef: 'vault-dashscope',
          ossAccessKeyIdRef: 'vault-oss-id',
          ossAccessKeySecretRef: 'vault-oss-secret',
          model: 'fun-asr',
          pricing: { creditsPerCall, costYuanPerCall: 0.08 },
        },
      }, null, 2), 'utf-8');
    };
    writeWithStt(false, 0);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      stt: {
        enabled: false,
        apiKeyRef: 'vault-dashscope',
        ossAccessKeyIdRef: 'vault-oss-id',
        ossAccessKeySecretRef: 'vault-oss-secret',
        model: 'fun-asr',
        pricing: { creditsPerCall: 0, costYuanPerCall: 0.08 },
      },
    } as unknown as AppConfig;
    const seen: string[] = [];
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      onSttUpdated: (next) => {
        seen.push(`${next?.enabled}:${next?.pricing?.creditsPerCall}`);
      },
      now: () => clock,
    });

    writeWithStt(true, 123);
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.stt?.enabled).toBe(true);
    expect(config.stt?.pricing?.creditsPerCall).toBe(123);
    expect(seen).toEqual(['true:123']);
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
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config, processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      now: () => clock,
    });

    source.attachRefresh(refresher.refreshIfChanged);

    expect(source.executionEnabled()).toBe(false);
    expect(refresher.getAppliedStamps().config).toBeDefined();
    clock += 5_000;
  });

  it('webTools 未变化时不触发回调', () => {
    writeConfig(dir, [BASE_GROUP]);
    const config = { models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' } } as unknown as AppConfig;
    let calls = 0;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      onWebToolsUpdated: () => { calls += 1; },
      now: () => clock,
    });

    writeConfig(dir, [BASE_GROUP, QWEN_GROUP]);
    clock += 5_000;
    refresher.refreshIfChanged();

    expect(config.models!.groups.map((g) => g.id)).toContain('qwen');
    expect(calls).toBe(0);
  });
});
