import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { createSharedConfigRefresher } from './sharedConfigRefresher.js';
import { configureModelPricing, computeCostMicro } from '../data/usage/pricing.js';

function group(id: string, price: number) {
  return {
    id,
    name: id,
    baseUrl: 'https://example.invalid/v1',
    protocol: 'responses',
    apiKey: `sk-${id}`,
    models: [
      {
        id: `${id}-model`,
        name: `${id}-model`,
        value: `${id}-model`,
        pricing: { input: price, output: price, cacheCreation: 0, cacheRead: 0 },
      },
    ],
  };
}

const OLD_GROUP = group('old', 1);
const CANDIDATE_GROUP = group('candidate', 7);
const WINNER_GROUP = group('winner', 11);

function rawConfig(
  modelGroup: ReturnType<typeof group>,
  prompt: string,
  credits: number,
  provider: string,
) {
  const modelRef = `${modelGroup.id}/${modelGroup.models[0]!.id}`;
  return {
    agent: { cwd: '.' },
    server: { port: 3200 },
    models: { groups: [modelGroup], default: modelRef },
    titleGenerator: { model: modelRef, fallbackModels: [] },
    guardrail: { model: modelRef, fallbackModels: [] },
    systemPrompts: { 'utility.title': prompt },
    stt: {
      enabled: credits > 0,
      apiKeyRef: `stt-${prompt}`,
      ossAccessKeyIdRef: `oss-id-${prompt}`,
      ossAccessKeySecretRef: `oss-secret-${prompt}`,
      model: 'fun-asr',
      pricing: { creditsPerCall: credits, costYuanPerCall: 0.08 },
    },
    webTools: { enabled: true, search: { provider, apiKeyRef: `web-${provider}` } },
  };
}

const OLD = rawConfig(OLD_GROUP, 'old prompt', 1, 'tencent_wsa');
const CANDIDATE = rawConfig(CANDIDATE_GROUP, 'candidate prompt', 7, 'zhipu');
const WINNER = rawConfig(WINNER_GROUP, 'winner prompt', 11, 'tavily');

function writeConfig(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(value), 'utf-8');
}

function cost(model: string): number {
  return computeCostMicro(model, {
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

describe('SharedConfigRefresher commit/post-check/rollback 与脏切面恢复事务', () => {
  let dir: string;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shared-config-transaction-'));
    previousConfigPath = process.env.AGENT_SAAS_CONFIG_PATH;
    process.env.AGENT_SAAS_CONFIG_PATH = join(dir, 'config.json');
    configureModelPricing(OLD.models);
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.AGENT_SAAS_CONFIG_PATH;
    else process.env.AGENT_SAAS_CONFIG_PATH = previousConfigPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function createHarness(params?: {
    asyncWeb?: boolean;
    failRollbackPrepare?: boolean;
    failRollbackCommit?: boolean;
    failWebRollbackCommit?: boolean;
    overwriteWith?: unknown;
  }) {
    writeConfig(dir, OLD);
    const config = structuredClone(OLD) as unknown as AppConfig;
    const titleGeneratorConfigs: Array<{ model: string }> = [{ model: OLD.titleGenerator.model }];
    let guardrailModels: Array<{ model: string }> = [{ model: OLD.guardrail.model }];
    let prompt = OLD.systemPrompts['utility.title'];
    let sttCredits = OLD.stt.pricing.creditsPerCall;
    let webProvider = OLD.webTools.search.provider;
    let reloadCalls = 0;
    let promptRollbackFailures = params?.failRollbackCommit ? 1 : 0;
    let webRollbackFailures = params?.failWebRollbackCommit ? 1 : 0;
    const infos: string[] = [];
    const warns: string[] = [];

    const preparePrompt = (next: NonNullable<AppConfig['systemPrompts']>) => {
      const nextPrompt = next['utility.title'] ?? '';
      if (params?.failRollbackPrepare && nextPrompt === OLD.systemPrompts['utility.title']) {
        throw new Error('rollback prompt prepare failed');
      }
      return () => {
        if (nextPrompt === CANDIDATE.systemPrompts['utility.title'] || nextPrompt === '') {
          writeConfig(dir, params?.overwriteWith ?? WINNER);
        }
        if (promptRollbackFailures > 0 && nextPrompt === OLD.systemPrompts['utility.title']) {
          promptRollbackFailures -= 1;
          throw new Error('rollback prompt commit failed');
        }
        prompt = nextPrompt;
      };
    };
    const prepareWeb = (next: AppConfig['webTools']) => {
      const nextProvider = next?.search?.provider ?? 'none';
      const commit = () => {
        if (webRollbackFailures > 0 && nextProvider === OLD.webTools.search.provider) {
          webRollbackFailures -= 1;
          throw new Error('rollback web commit failed');
        }
        webProvider = nextProvider;
      };
      return params?.asyncWeb ? Promise.resolve(commit) : commit;
    };
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: dir,
      target: {
        titleGeneratorConfigs,
        updateGuardrailModelConfigs: (next) => {
          guardrailModels = next;
        },
      },
      prepareSystemPromptOverridesUpdate: preparePrompt,
      prepareSttUpdate: (next) => () => {
        sttCredits = next?.pricing?.creditsPerCall ?? 0;
      },
      prepareWebToolsUpdate: prepareWeb,
      onConfigReloaded: () => {
        reloadCalls += 1;
      },
      logger: { info: (message) => infos.push(message), warn: (message) => warns.push(message) },
      now: () => 10_000,
    });

    return {
      config,
      refresher,
      infos,
      warns,
      resetPublished: () => {
        reloadCalls = 0;
        infos.length = 0;
      },
      state: () => ({
        titleModel: titleGeneratorConfigs[0]?.model,
        guardrailModel: guardrailModels[0]?.model,
        prompt,
        sttCredits,
        webProvider,
        reloadCalls,
      }),
    };
  }

  async function establishOldStamp(harness: ReturnType<typeof createHarness>) {
    expect(await harness.refresher.refreshIfChanged(true)).toBe(true);
    const stamp = harness.refresher.getAppliedStamps().config;
    expect(stamp).toBeDefined();
    harness.resetPublished();
    return stamp;
  }

  async function expectLoserRolledBackAndWinnerPublished(asyncWeb: boolean) {
    const harness = createHarness({ asyncWeb });
    const oldStamp = await establishOldStamp(harness);
    writeConfig(dir, CANDIDATE);

    expect(await harness.refresher.refreshIfChanged(true)).toBe(false);
    expect(harness.config.models?.groups[0]?.id).toBe('old');
    expect(harness.config.systemPrompts?.['utility.title']).toBe('old prompt');
    expect(harness.config.stt?.pricing?.creditsPerCall).toBe(1);
    expect(harness.config.webTools?.search?.provider).toBe('tencent_wsa');
    expect(harness.state()).toEqual({
      titleModel: 'old-model',
      guardrailModel: 'old-model',
      prompt: 'old prompt',
      sttCredits: 1,
      webProvider: 'tencent_wsa',
      reloadCalls: 0,
    });
    expect(cost('old-model')).toBe(1);
    expect(harness.refresher.getAppliedStamps().config).toEqual(oldStamp);
    expect(harness.infos).toEqual([]);

    expect(await harness.refresher.refreshIfChanged(true)).toBe(true);
    expect(harness.config.models?.groups[0]?.id).toBe('winner');
    expect(harness.config.systemPrompts?.['utility.title']).toBe('winner prompt');
    expect(harness.config.stt?.pricing?.creditsPerCall).toBe(11);
    expect(harness.config.webTools?.search?.provider).toBe('tavily');
    expect(harness.state()).toEqual({
      titleModel: 'winner-model',
      guardrailModel: 'winner-model',
      prompt: 'winner prompt',
      sttCredits: 11,
      webProvider: 'tavily',
      reloadCalls: 1,
    });
    expect(cost('winner-model')).toBe(11);
    expect(harness.refresher.getAppliedStamps().config).not.toEqual(oldStamp);
  }

  it('同步 prepare：候选 commit 内写入 winner 时完整回滚，下一次只发布 winner', async () => {
    await expectLoserRolledBackAndWinnerPublished(false);
  });

  it('异步 prepare：候选 commit 内写入 winner 时完整回滚，下一次只发布 winner', async () => {
    await expectLoserRolledBackAndWinnerPublished(true);
  });

  it('候选删除字段后发生覆盖时恢复 AppConfig 与全部执行侧旧值', async () => {
    const harness = createHarness();
    const oldStamp = await establishOldStamp(harness);
    writeConfig(dir, {
      agent: OLD.agent,
      server: OLD.server,
      models: OLD.models,
    });

    expect(await harness.refresher.refreshIfChanged(true)).toBe(false);
    expect(harness.config.titleGenerator).toEqual(OLD.titleGenerator);
    expect(harness.config.guardrail).toEqual(OLD.guardrail);
    expect(harness.config.systemPrompts).toEqual(OLD.systemPrompts);
    expect(harness.config.stt).toEqual(OLD.stt);
    expect(harness.config.webTools).toEqual(OLD.webTools);
    expect(harness.state()).toEqual({
      titleModel: 'old-model',
      guardrailModel: 'old-model',
      prompt: 'old prompt',
      sttCredits: 1,
      webProvider: 'tencent_wsa',
      reloadCalls: 0,
    });
    expect(harness.refresher.getAppliedStamps().config).toEqual(oldStamp);
  });

  it('rollback prepare 失败时在任何候选副作用前 fail closed', async () => {
    const harness = createHarness({ failRollbackPrepare: true });
    const oldStamp = await establishOldStamp(harness);
    writeConfig(dir, CANDIDATE);

    expect(await harness.refresher.refreshIfChanged(true)).toBe(false);
    expect(harness.config.models?.groups[0]?.id).toBe('old');
    expect(harness.state().prompt).toBe('old prompt');
    expect(harness.state().reloadCalls).toBe(0);
    expect(harness.refresher.getAppliedStamps().config).toEqual(oldStamp);
    expect(
      harness.warns.some((message) => message.includes('rollback prompt prepare failed')),
    ).toBe(true);
  });

  it('rollback commit 失败时继续回滚其余切面且不发布 stamp/identity', async () => {
    const harness = createHarness({ failRollbackCommit: true });
    const oldStamp = await establishOldStamp(harness);
    writeConfig(dir, CANDIDATE);

    expect(await harness.refresher.refreshIfChanged(true)).toBe(false);
    expect(harness.config.models?.groups[0]?.id).toBe('old');
    expect(harness.config.systemPrompts?.['utility.title']).toBe('old prompt');
    expect(harness.state().titleModel).toBe('old-model');
    expect(harness.state().guardrailModel).toBe('old-model');
    expect(cost('old-model')).toBe(1);
    expect(harness.state().reloadCalls).toBe(0);
    expect(harness.refresher.getAppliedStamps().config).toEqual(oldStamp);
    expect(harness.warns.some((message) => message.includes('rollback prompt commit failed'))).toBe(
      true,
    );
  });

  it.each(['models', 'prompt'] as const)(
    'async validation 不会先于同步 %s prepare 启动或产生 unhandled rejection',
    async (failure) => {
      const invalidCandidate = structuredClone(CANDIDATE);
      if (failure === 'models') invalidCandidate.titleGenerator.model = 'missing/model';
      writeConfig(dir, OLD);
      const config = structuredClone(OLD) as unknown as AppConfig;
      let validationCalls = 0;
      let reloadCalls = 0;
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      try {
        const refresher = createSharedConfigRefresher({
          config,
          processCwd: dir,
          target: { titleGeneratorConfigs: [], updateGuardrailModelConfigs: () => {} },
          validateConfigReload: () => {
            validationCalls += 1;
            return Promise.reject(new Error('validation rejected'));
          },
          prepareSystemPromptOverridesUpdate: (next) => {
            if (failure === 'prompt' && next['utility.title'] === 'candidate prompt') {
              throw new Error('prompt sync prepare failed');
            }
            return () => {};
          },
          onConfigReloaded: () => {
            reloadCalls += 1;
          },
        });
        writeConfig(dir, invalidCandidate);

        expect(refresher.refreshIfChanged(true)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(validationCalls).toBe(0);
        expect(unhandled).toEqual([]);
        expect(config.models?.groups[0]?.id).toBe('old');
        expect(reloadCalls).toBe(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  it('候选 async rejection 后 rollback 同步抛错时仍启动全部 prepare 并消费 rejection', async () => {
    writeConfig(dir, OLD);
    const config = structuredClone(OLD) as unknown as AppConfig;
    const prepareCalls: string[] = [];
    let rejectPreparations = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const refresher = createSharedConfigRefresher({
        config,
        processCwd: dir,
        target: { titleGeneratorConfigs: [], updateGuardrailModelConfigs: () => {} },
        prepareWebToolsUpdate: (next) => {
          const label = `web:${next?.search?.provider}`;
          prepareCalls.push(label);
          if (rejectPreparations && next?.search?.provider === 'tencent_wsa') {
            throw new Error(`${label}: sync rollback failure`);
          }
          return rejectPreparations
            ? Promise.reject(new Error(`${label}: async candidate rejection`))
            : Promise.resolve(() => {});
        },
        prepareSttUpdate: (next) => {
          const label = `stt:${next?.pricing?.creditsPerCall}`;
          prepareCalls.push(label);
          return rejectPreparations ? Promise.reject(new Error(label)) : Promise.resolve(() => {});
        },
      });
      expect(await refresher.refreshIfChanged(true)).toBe(true);
      prepareCalls.length = 0;
      rejectPreparations = true;
      writeConfig(dir, CANDIDATE);

      expect(await refresher.refreshIfChanged(true)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(prepareCalls).toEqual(['web:zhipu', 'web:tencent_wsa', 'stt:7', 'stt:1']);
      expect(unhandled).toEqual([]);
      expect(config.models?.groups[0]?.id).toBe('old');
      expect(config.webTools?.search?.provider).toBe('tencent_wsa');
      expect(config.stt?.pricing?.creditsPerCall).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.each([
    { facet: 'prompt', options: { failRollbackCommit: true } },
    { facet: 'web', options: { failWebRollbackCommit: true } },
  ] as const)(
    '$facet rollback 失败后 winner 等于旧 AppConfig 仍强制重放，成功后才发布 identity',
    async ({ facet, options }) => {
      const harness = createHarness({ ...options, overwriteWith: OLD });
      const oldStamp = await establishOldStamp(harness);
      writeConfig(dir, CANDIDATE);

      expect(await harness.refresher.refreshIfChanged(true)).toBe(false);
      expect(harness.config.systemPrompts?.['utility.title']).toBe('old prompt');
      expect(harness.config.webTools?.search?.provider).toBe('tencent_wsa');
      expect(harness.state()[facet === 'prompt' ? 'prompt' : 'webProvider']).toBe(
        facet === 'prompt' ? 'candidate prompt' : 'zhipu',
      );
      expect(harness.state().reloadCalls).toBe(0);
      expect(harness.refresher.getAppliedStamps().config).toEqual(oldStamp);
      expect(harness.warns.some((message) => message.includes('脏执行切面'))).toBe(true);

      expect(await harness.refresher.refreshIfChanged(true)).toBe(true);
      expect(harness.state()[facet === 'prompt' ? 'prompt' : 'webProvider']).toBe(
        facet === 'prompt' ? 'old prompt' : 'tencent_wsa',
      );
      expect(harness.state().reloadCalls).toBe(1);
      expect(
        harness.infos.some((message) => message.includes('脏执行切面已随完整 post-check 成功清理')),
      ).toBe(true);
    },
  );

  it('候选删除字段且多切面 rollback 失败时逐项标脏，并强制恢复删除前 winner', async () => {
    const harness = createHarness({
      failRollbackCommit: true,
      failWebRollbackCommit: true,
      overwriteWith: OLD,
    });
    const oldStamp = await establishOldStamp(harness);
    writeConfig(dir, { agent: OLD.agent, server: OLD.server, models: OLD.models });

    expect(await harness.refresher.refreshIfChanged(true)).toBe(false);
    expect(harness.config.systemPrompts).toEqual(OLD.systemPrompts);
    expect(harness.config.webTools).toEqual(OLD.webTools);
    expect(harness.state().prompt).toBe('');
    expect(harness.state().webProvider).toBe('none');
    expect(harness.state().reloadCalls).toBe(0);
    expect(harness.refresher.getAppliedStamps().config).toEqual(oldStamp);
    expect(harness.warns.some((message) => message.includes('systemPrompt'))).toBe(true);
    expect(harness.warns.some((message) => message.includes('WebTools'))).toBe(true);

    expect(await harness.refresher.refreshIfChanged(true)).toBe(true);
    expect(harness.state().prompt).toBe('old prompt');
    expect(harness.state().webProvider).toBe('tencent_wsa');
    expect(harness.state().reloadCalls).toBe(1);
  });
});
