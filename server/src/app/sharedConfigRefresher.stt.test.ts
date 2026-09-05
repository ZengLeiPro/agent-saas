import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { createSharedConfigRefresher } from './sharedConfigRefresher.js';

const BASE_GROUP = {
  id: 'ark-agents',
  name: '火山 Agent Plan',
  baseUrl: 'https://example.invalid/api/v3',
  protocol: 'responses',
  apiKey: 'sk-base-key',
  models: [{ id: 'glm-5.2', name: 'glm-5.2', value: 'glm-5.2' }],
};

const STT = {
  enabled: false,
  apiKeyRef: 'vault-dashscope',
  ossAccessKeyIdRef: 'vault-oss-id',
  ossAccessKeySecretRef: 'vault-oss-secret',
  model: 'fun-asr',
  pricing: { creditsPerCall: 0, costYuanPerCall: 0.08 },
};

describe('SharedConfigRefresher STT 两阶段提交', () => {
  let dir: string;
  let prevConfigPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-config-stt-'));
    prevConfigPath = process.env.AGENT_SAAS_CONFIG_PATH;
    process.env.AGENT_SAAS_CONFIG_PATH = join(dir, 'config.json');
  });

  afterEach(() => {
    if (prevConfigPath === undefined) delete process.env.AGENT_SAAS_CONFIG_PATH;
    else process.env.AGENT_SAAS_CONFIG_PATH = prevConfigPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('异步准备失败保留旧状态，并在节流窗口内立即重试一致提交', async () => {
    const writeCandidate = (enabled: boolean) =>
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          agent: { cwd: '.' },
          server: { port: 3200 },
          models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
          stt: { ...STT, enabled },
        }),
      );
    writeCandidate(false);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      stt: STT,
    } as unknown as AppConfig;
    let attempts = 0;
    let runtimeEnabled = false;
    let reloadCalls = 0;
    let clock = 10_000;
    const warns: string[] = [];
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      prepareSttUpdate: async (next) => {
        attempts += 1;
        if (attempts === 1) throw new Error('STT SecretVault resolve failed');
        return () => {
          runtimeEnabled = next?.enabled === true;
        };
      },
      onConfigReloaded: () => {
        reloadCalls += 1;
      },
      logger: { info: () => {}, warn: (message) => warns.push(message) },
      now: () => clock,
    });
    const initialStamp = refresher.getAppliedStamps().config;

    writeCandidate(true);
    clock += 5_000;
    expect(await refresher.refreshIfChanged()).toBe(false);
    expect(config.stt?.enabled).toBe(false);
    expect(runtimeEnabled).toBe(false);
    expect(reloadCalls).toBe(0);
    expect(refresher.getAppliedStamps().config).toEqual(initialStamp);
    expect(warns.some((message) => message.includes('STT SecretVault resolve failed'))).toBe(true);

    // 失败后即使仍在 stat 节流窗口，也必须立即重试，而不是误报 true 后使用旧配置。
    expect(await refresher.refreshIfChanged()).toBe(true);
    expect(config.stt?.enabled).toBe(true);
    expect(runtimeEnabled).toBe(true);
    expect(reloadCalls).toBe(1);
    expect(refresher.getAppliedStamps().config).not.toEqual(initialStamp);
  });

  it('异步 prepare 期间候选变化时丢弃旧 commit，只发布最新版', async () => {
    const writeCandidate = (creditsPerCall: number) =>
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          agent: { cwd: '.' },
          server: { port: 3200 },
          models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
          stt: { ...STT, enabled: creditsPerCall > 0, pricing: { ...STT.pricing, creditsPerCall } },
        }),
      );
    writeCandidate(0);
    const config = {
      models: { groups: [BASE_GROUP], default: 'ark-agents/glm-5.2' },
      stt: STT,
    } as unknown as AppConfig;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let preparations = 0;
    let runtimeCredits = 0;
    let reloadCalls = 0;
    let clock = 10_000;
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: { updateGuardrailModelConfigs: () => {}, titleGeneratorConfigs: [] },
      prepareSttUpdate: async (next) => {
        preparations += 1;
        if (preparations === 1) await firstGate;
        return () => {
          runtimeCredits = next?.pricing?.creditsPerCall ?? 0;
        };
      },
      onConfigReloaded: () => {
        reloadCalls += 1;
      },
      now: () => clock,
    });

    writeCandidate(111);
    clock += 5_000;
    const firstRefresh = refresher.refreshIfChanged(true);
    writeCandidate(9_999);
    releaseFirst();
    expect(await firstRefresh).toBe(false);
    expect(config.stt?.pricing?.creditsPerCall).toBe(0);
    expect(runtimeCredits).toBe(0);
    expect(reloadCalls).toBe(0);

    clock += 5_000;
    expect(await refresher.refreshIfChanged(true)).toBe(true);
    expect(config.stt?.pricing?.creditsPerCall).toBe(9_999);
    expect(runtimeCredits).toBe(9_999);
    expect(reloadCalls).toBe(1);
  });
});
