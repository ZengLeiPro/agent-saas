import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../app/config.js';
import {
  CAPABILITY_IDS,
  capabilityConfigFingerprint,
  resolveCapabilityState,
} from '../config/capabilityContract.js';
import { buildCapabilityReadiness, capabilitySnapshot } from '../config/capabilityReadiness.js';

function appConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    agent: { cwd: '/tmp/workspace' },
    server: { port: 3000 },
    ...overrides,
  } as never;
}

function readiness(overrides: Record<string, unknown> = {}) {
  return buildCapabilityReadiness({ config: appConfig(overrides) });
}

describe('capability readiness', () => {
  it('覆盖全部 14 项能力并给出目标业务页面', () => {
    const states = readiness();
    expect(Object.keys(states).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(states.webTools.targetRouteId).toBe('platform.resource-center.tools');
    expect(states.acs.targetRouteId).toBe('platform.runtime.execution-providers');
    // 语音合成还没有独立后台入口，不能编一个路由出来。
    expect(states.tts.targetRouteId).toBeNull();
  });

  it('缺少 Secret 的未启用能力是 incomplete，而不是 disabled', () => {
    const states = readiness({ webTools: { enabled: false, search: { provider: 'brave' } } });
    expect(states.webTools.state).toBe('incomplete');
    expect(states.webTools.missing).toEqual(['webTools.search.apiKeyRef']);
  });

  it('配置齐备但未启用时是 disabled', () => {
    const states = readiness({
      webTools: { enabled: false, search: { provider: 'brave', apiKeyRef: 'ref-1' } },
    });
    expect(states.webTools.state).toBe('disabled');
    expect(states.webTools.missing).toEqual([]);
  });

  it('TTS 只有显式启用且凭据完整时才进入兼容能力表', () => {
    expect(
      capabilitySnapshot(
        appConfig({ tts: { doubaoAppId: 'app', doubaoApiKey: 'key' } }),
      ).tts,
    ).toBe(false);
    expect(
      capabilitySnapshot(
        appConfig({ tts: { enabled: true, doubaoAppId: 'app', doubaoApiKey: 'key' } }),
      ).tts,
    ).toBe(true);
  });

  it('已启用但配置不完整时是 degraded', () => {
    const states = readiness({
      stt: { enabled: true, apiKeyRef: 'ref-1' },
    });
    expect(states.stt.state).toBe('degraded');
    expect(states.stt.missing).toEqual(['stt.ossAccessKeyIdRef', 'stt.ossAccessKeySecretRef']);
  });

  it('默认模型解析不到已配置模型时报告 models.default', () => {
    const states = readiness({
      models: {
        default: 'g/missing',
        allowCrossGroupSwitch: false,
        groups: [
          { id: 'g', name: 'G', apiKeyRef: 'ref', models: [{ id: 'm', name: 'M', value: 'm' }] },
        ],
      },
    });
    expect(states.models.state).toBe('degraded');
    expect(states.models.missing).toEqual(['models.default']);
  });

  it('依赖未满足的能力是 blocked，并指向要先解决的页面', () => {
    const states = readiness({ memory: { enabled: false, polling: { enabled: true } } });
    expect(states.memoryPolling.state).toBe('blocked');
    expect(states.memoryPolling.blockers).toEqual([
      {
        code: 'CAPABILITY_DEPENDENCY_DISABLED',
        message: '记忆轮询要求先启用 Memory 总能力',
        targetRouteId: 'platform.governance.memory-policy',
      },
    ]);
  });

  it('调度窗口跨越次日属于参数组合阻塞', () => {
    const states = readiness({
      memory: { enabled: true, polling: { enabled: true, hour: 22, hoursSpan: 6 } },
    });
    expect(states.memoryPolling.state).toBe('blocked');
    expect(states.memoryPolling.blockers[0]?.code).toBe('CAPABILITY_INVALID_PARAMETER_COMBINATION');
  });

  it('记忆整合要求 PostgreSQL 事件存储且 lease 大于 timeout', () => {
    const pg = { runtimeEventStore: { backend: 'pg' }, memory: { enabled: true } };
    expect(
      readiness({ ...pg, runtimeEventStore: { backend: 'sqlite' } }).memoryConsolidation.blockers,
    ).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_RUNTIME_STORE_UNSUPPORTED' }));
    const states = readiness({
      ...pg,
      memory: {
        enabled: true,
        consolidation: { enabled: true, leaseSeconds: 600, timeoutSeconds: 900 },
      },
    });
    expect(states.memoryConsolidation.blockers).toContainEqual(
      expect.objectContaining({ code: 'CAPABILITY_INVALID_PARAMETER_COMBINATION' }),
    );
  });

  it('事件保留切到 execute 时要求授权引用与正数法务水位', () => {
    const states = readiness({
      runtimeEventStore: { backend: 'pg' },
      runtimeEventRetention: {
        enabled: true,
        executionMode: 'execute',
        legalDeleteThroughGlobalSequence: '0',
      },
    });
    expect(states.eventRetention.state).toBe('degraded');
    expect(states.eventRetention.missing).toEqual([
      'runtimeEventRetention.authorizationRef',
      'runtimeEventRetention.legalDeleteThroughGlobalSequence',
    ]);
  });

  it('显式点亮的工具依赖未就绪能力时阻塞工具控制', () => {
    const states = readiness({
      imageGenTools: { enabled: true },
      toolControls: { enabled: true, tools: { GenerateImage: { enabled: true } } },
    });
    expect(states.toolControls.state).toBe('blocked');
    expect(states.toolControls.blockers[0]?.targetRouteId).toBe('platform.resource-center.tools');
  });

  it('依赖能力整体未开启时，默认可见的工具不算阻塞', () => {
    const states = readiness({ toolControls: { enabled: true } });
    expect(states.toolControls.state).toBe('enabled');
    expect(states.toolControls.blockers).toEqual([]);
  });

  it('验证记录只在指纹仍匹配时生效', () => {
    const config = appConfig({
      webTools: { enabled: false, search: { provider: 'brave', apiKeyRef: 'ref-1' } },
    });
    const fingerprint = capabilityConfigFingerprint(config, 'webTools');
    const validated = buildCapabilityReadiness({
      config,
      validations: {
        record: () => ({
          status: 'passed' as const,
          validatedAt: '2026-09-01T00:00:00.000Z',
          configFingerprint: fingerprint,
        }),
        isValidating: () => false,
      },
    });
    expect(validated.webTools.state).toBe('ready');

    const stale = buildCapabilityReadiness({
      config,
      validations: {
        record: () => ({
          status: 'passed' as const,
          validatedAt: '2026-09-01T00:00:00.000Z',
          configFingerprint: 'sha256:stale',
        }),
        isValidating: () => false,
      },
    });
    expect(stale.webTools.state).toBe('disabled');
  });

  it('验证进行中时优先展示 validating', () => {
    const states = buildCapabilityReadiness({
      config: appConfig({ webTools: { enabled: true, search: { apiKeyRef: 'ref' } } }),
      validations: { record: () => undefined, isValidating: (id) => id === 'webTools' },
    });
    expect(states.webTools.state).toBe('validating');
  });

  it('状态机让阻塞优先于其他一切判定', () => {
    expect(
      resolveCapabilityState({
        enabled: true,
        missing: [],
        blockers: [{ code: 'X', message: 'x' }],
        validating: true,
        verification: 'passed',
      }),
    ).toBe('blocked');
  });

  it('已启用能力的验证记录过期即降级，绕过向导改配置藏不住', () => {
    const config = appConfig({
      webTools: { enabled: true, search: { provider: 'brave', apiKeyRef: 'ref-1' } },
    });
    const staleValidation = {
      record: () => ({
        status: 'passed' as const,
        validatedAt: '2026-08-30T00:00:00.000Z',
        // 管理员直接改了 config.json，能力切片指纹已经不是验证当时那份。
        configFingerprint: 'sha256:before-the-hand-edit',
      }),
      isValidating: () => false,
    };
    const states = buildCapabilityReadiness({ config, validations: staleValidation });
    expect(states.webTools.state).toBe('degraded');
    expect(states.webTools.verification).toBe('stale');
  });

  it('从未验证过的已启用能力如实标注 never，不冒充验证通过', () => {
    const states = readiness({
      webTools: { enabled: true, search: { provider: 'brave', apiKeyRef: 'ref-1' } },
    });
    expect(states.webTools.state).toBe('enabled');
    expect(states.webTools.verification).toBe('never');
  });

  it('依赖能力探测失败时，显式点亮的工具被判为阻塞', () => {
    const config = appConfig({
      webTools: { enabled: true, search: { provider: 'brave', apiKeyRef: 'ref-1' } },
      toolControls: { enabled: true, tools: { WebSearch: { enabled: true } } },
    });
    const states = buildCapabilityReadiness({
      config,
      validations: {
        record: (capability) =>
          capability === 'webTools'
            ? {
                status: 'failed' as const,
                validatedAt: '2026-09-01T00:00:00.000Z',
                configFingerprint: capabilityConfigFingerprint(config, 'webTools'),
              }
            : undefined,
        isValidating: () => false,
      },
    });
    expect(states.webTools.state).toBe('degraded');
    expect(states.toolControls.state).toBe('blocked');
    expect(states.toolControls.blockers[0]?.message).toContain('WebSearch');
  });

  it('依赖能力探测失败时，默认可见的工具同样被判为阻塞', () => {
    const config = appConfig({
      imageGenTools: { enabled: true, gptImage2: { baseUrl: 'https://x.test/v1', apiKeyRef: 'r' } },
      toolControls: { enabled: true },
    });
    const states = buildCapabilityReadiness({
      config,
      validations: {
        record: (capability) =>
          capability === 'imageGen'
            ? {
                status: 'failed' as const,
                validatedAt: '2026-09-01T00:00:00.000Z',
                configFingerprint: capabilityConfigFingerprint(config, 'imageGen'),
              }
            : undefined,
        isValidating: () => false,
      },
    });
    expect(states.imageGen.state).toBe('degraded');
    expect(states.toolControls.state).toBe('blocked');
  });
});
