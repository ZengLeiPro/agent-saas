import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';

/**
 * 容量回收的失败隔离（2026-08-11，ACS run 31440440098 事故回归）。
 *
 * 发布瞬间 startup 的 stale-image 退休流程会与用户 provision 并发操作同一批
 * Sandbox / 同一张 SNAT 表，回收链路里任意一次 kubectl 或阿里云调用失败，此前
 * 都会顺着 ensureCapacity 冒泡把整个 provision 打成 500——表现为「平时都好，
 * 一发布就失败」。回收只是尽力而为的维护动作，配额够不够由硬检查负责。
 */
function config(overrides: Partial<AcsOrchestratorConfig> = {}): AcsOrchestratorConfig {
  return {
    namespace: 'agent-saas-coding',
    sandboxApiVersion: 'agents.kruise.io/v1alpha1',
    sandboxKind: 'Sandbox',
    sandboxImage: 'registry.example.com/acs-sandbox:test',
    sandboxContainerName: 'sandbox',
    sandboxRuntimes: [],
    workspaceMountPath: '/workspace',
    imagePullSecretNames: [],
    imagePullPolicy: 'IfNotPresent',
    sandboxRunAsUser: 501,
    sandboxRunAsGroup: 20,
    cpuRequest: '500m',
    memoryRequest: '1Gi',
    sandboxWaitTimeoutMs: 1,
    execTimeoutMs: 1,
    imageCacheEnabled: false,
    skipProvisionOnSameRecipe: false,
    lifecycleEnabled: true,
    maxRunningSandboxes: 200,
    sandboxIdlePauseMs: 0,
    sandboxTtlMs: 0,
    sandboxCiTtlMs: 0,
    sandboxOrphanGraceMs: 0,
    sandboxBrokenRecycleGraceMs: 0,
    networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    snat: { mode: 'disabled' },
    egress: {
      proxy: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    },
    ...overrides,
  } as unknown as AcsOrchestratorConfig;
}

/**
 * 第 1 次 `get sandbox -l`（回收链路的清点）失败，其余调用正常。
 * 用调用序号而不是参数区分，是为了精确复刻「回收先跑、随后主链路自己再清点一次」
 * 的真实顺序。
 */
function kubectlFailingFirstList(): { kubectl: Kubectl; listCalls: () => number } {
  let listCount = 0;
  let created = false;
  const kubectl = {
    async run(args: string[]): Promise<KubectlResult> {
      if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
        listCount += 1;
        if (listCount === 1) throw new Error('kubectl list failed: etcdserver: leader changed');
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'get') {
        if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
        return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'apply') {
        created = true;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      if (args[0] === 'patch' || args[0] === 'delete') {
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
    },
  } as unknown as Kubectl;
  return { kubectl, listCalls: () => listCount };
}

describe('ensureCapacity 硬门禁', () => {
  it('权威 inventory 读取失败时 fail closed，不在未知容量下继续 provision', async () => {
    const warnings: string[] = [];
    const logger = { info() {}, warn(message: string) { warnings.push(message); }, error() {} };
    const { kubectl, listCalls } = kubectlFailingFirstList();
    const manager = new SandboxManager(config(), kubectl, logger);

    await expect(manager.ensureRunning({
      workspaceId: 'ws_kaiyan__u1',
      sessionId: 'session-abc',
      mountSubPath: 'workspaces/kaiyan/u1',
    })).rejects.toThrow(/kubectl list failed/);

    expect(warnings.some((m) => m.includes('sandbox_ensure_step_failed'))).toBe(true);
    expect(listCalls()).toBe(1);
  });

  it('并发创建在 Pod 可见前也会占用容量保留，禁止同时穿透上限', async () => {
    let releaseApply!: () => void;
    let notifyApplyStarted!: () => void;
    const applyStarted = new Promise<void>((resolve) => { notifyApplyStarted = resolve; });
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    const running = new Set<string>();
    let firstSandboxName = '';
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') {
          const name = args[1]?.split('/').at(-1) ?? '';
          return running.has(name)
            ? { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null }
            : { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
        }
        if (args[0] === 'apply') {
          notifyApplyStarted();
          await applyGate;
          void options.input;
          if (firstSandboxName) running.add(firstSandboxName);
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch' || args[0] === 'delete') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(
      config({ maxRunningSandboxes: 1, lifecycleEnabled: false }), kubectl,
      { info() {}, warn() {}, error() {} },
    );
    firstSandboxName = manager.ref({ workspaceId: 'ws_kaiyan__u1', sessionId: 'session-a' }).name;
    const first = manager.ensureRunning({ workspaceId: 'ws_kaiyan__u1', sessionId: 'session-a' });
    await applyStarted;
    await expect(manager.ensureRunning({ workspaceId: 'ws_kaiyan__u2', sessionId: 'session-b' }))
      .rejects.toThrow(/capacity exhausted/);
    releaseApply();
    await first;
  });

  it('配额真的用尽时仍然拒绝创建——失败隔离不等于放弃配额约束', async () => {
    const running = Array.from({ length: 3 }, (_, i) => ({
      metadata: {
        name: `as-ws-other-${i}`,
        annotations: {
          'agent-saas.kaiyan.net/workspace-id': `ws-other-${i}`,
          'agent-saas.kaiyan.net/sandbox-scope-id': `ws-other-${i}`,
        },
      },
      status: { phase: 'Running' },
    }));
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: running }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
        if (args[0] === 'patch' || args[0] === 'delete') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        if (args[0] === 'apply') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    // lifecycle 关掉 → 不做回收，直接走配额硬检查
    const manager = new SandboxManager(
      config({ maxRunningSandboxes: 2, lifecycleEnabled: false }),
      kubectl,
      { info() {}, warn() {}, error() {} },
    );

    await expect(manager.ensureRunning({
      workspaceId: 'ws_kaiyan__u1',
      sessionId: 'session-abc',
      mountSubPath: 'workspaces/kaiyan/u1',
    })).rejects.toThrow(/capacity exhausted/);
  });
});
