import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { AcsExecutor } from './executor.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';

describe('AcsExecutor active sandbox tracking', () => {
  it('releases active tracking when sandbox startup fails', async () => {
    const ref: SandboxRef = {
      name: 'as-active',
      workspaceId: 'ws_kaiyan__u-1',
      sandboxScopeId: 'ws_kaiyan__u-1',
      sessionId: 'session-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
    };
    const activeRegistry = new ActiveSandboxRegistry();
    const sandboxManager = {
      ref: () => ref,
      ensureRunning: vi.fn(async () => {
        throw new Error('startup failed');
      }),
    } as unknown as SandboxManager;
    const kubectl = {
      spawn: vi.fn(),
    } as unknown as Kubectl;
    const executor = new AcsExecutor(baseConfig(), kubectl, sandboxManager, noopLogger, activeRegistry);

    const iterator = executor.executeStream({
      toolName: 'Shell',
      input: { command: 'pwd' },
      context: {
        invocationId: 'inv-fail',
        workspace: {
          id: ref.workspaceId,
          sessionId: ref.sessionId,
          sandboxScopeId: ref.sandboxScopeId,
          mountSubPath: ref.mountSubPath,
        },
      },
    }, { stream: true })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('startup failed');
    expect(activeRegistry.isBusy(ref.name)).toBe(false);
    expect(kubectl.spawn).not.toHaveBeenCalled();
  });

  it('keeps a sandbox busy after cancel until the runner exits', async () => {
    const ref: SandboxRef = {
      name: 'as-active',
      workspaceId: 'ws_kaiyan__u-1',
      sandboxScopeId: 'ws_kaiyan__u-1',
      sessionId: 'session-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
    };
    const activeRegistry = new ActiveSandboxRegistry();
    const child = fakeChild();
    const sandboxManager = {
      ref: () => ref,
      ensureRunning: vi.fn(async () => ref),
    } as unknown as SandboxManager;
    const kubectl = {
      spawn: vi.fn(() => child),
    } as unknown as Kubectl;
    const executor = new AcsExecutor(baseConfig(), kubectl, sandboxManager, noopLogger, activeRegistry);

    const iterator = executor.executeStream({
      toolName: 'Shell',
      input: { command: 'pwd' },
      context: {
        invocationId: 'inv-1',
        workspace: {
          id: ref.workspaceId,
          sessionId: ref.sessionId,
          sandboxScopeId: ref.sandboxScopeId,
          mountSubPath: ref.mountSubPath,
        },
      },
    }, { stream: true })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'progress', message: 'acs sandbox invocation accepted' },
      done: false,
    });
    expect(activeRegistry.isBusy(ref.name)).toBe(true);

    expect(executor.cancel('inv-1')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(activeRegistry.isBusy(ref.name)).toBe(true);

    child.stdout.end(`${JSON.stringify({ kind: 'final', response: { status: 'success', content: 'ok' } })}\n`);
    child.emit('close', 0, null);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'completed', response: { status: 'success', content: 'ok' } },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(activeRegistry.isBusy(ref.name)).toBe(false);
  });

  it('persists background shell lifecycle protection before returning the final response', async () => {
    const ref: SandboxRef = {
      name: 'as-background',
      workspaceId: 'ws_kaiyan__u-1',
      sandboxScopeId: 'ws_kaiyan__u-1',
      sessionId: 'session-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
    };
    const child = fakeChild();
    const setBackgroundShellProtection = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => ref,
      ensureRunning: vi.fn(async () => ref),
      setBackgroundShellProtection,
    } as unknown as SandboxManager;
    const kubectl = { spawn: vi.fn(() => child) } as unknown as Kubectl;
    const executor = new AcsExecutor(baseConfig(), kubectl, sandboxManager, noopLogger);
    const protectedUntil = '2026-07-20T00:00:00.000Z';

    const resultPromise = executor.execute({
      toolName: 'Shell',
      input: { command: 'sleep 60', mode: 'background' },
      context: {
        workspace: {
          id: ref.workspaceId,
          sessionId: ref.sessionId,
          sandboxScopeId: ref.sandboxScopeId,
          mountSubPath: ref.mountSubPath,
        },
      },
    });
    await vi.waitFor(() => expect(kubectl.spawn).toHaveBeenCalledOnce());
    child.stdout.end(`${JSON.stringify({
      kind: 'final',
      response: {
        status: 'success',
        content: '{}',
        metadata: { backgroundShell: { taskId: 'shell-bg-task-1', status: 'running', protectedUntil } },
      },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
    expect(setBackgroundShellProtection).toHaveBeenCalledWith(ref.name, protectedUntil);
  });
});

function fakeChild(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

function baseConfig(): AcsOrchestratorConfig {
  return {
    port: 3400,
    host: '127.0.0.1',
    authToken: 'test-token',
    kubectlPath: 'kubectl',
    namespace: 'agent-saas-coding',
    sandboxApiVersion: 'agents.kruise.io/v1alpha1',
    sandboxKind: 'Sandbox',
    sandboxCrdName: 'sandboxes.agents.kruise.io',
    trafficPolicyCrdName: 'trafficpolicies.network.alibabacloud.com',
    sandboxImage: 'registry.example.com/agent-saas/acs-sandbox:test',
    sandboxContainerName: 'sandbox',
    sandboxRuntimes: [],
    workspaceMountPath: '/workspace',
    pvcName: 'agent-saas-workspace-nas',
    imagePullSecretNames: [],
    imagePullPolicy: 'IfNotPresent',
    sandboxRunAsUser: 501,
    sandboxRunAsGroup: 20,
    cpuRequest: '250m',
    memoryRequest: '512Mi',
    sandboxWaitTimeoutMs: 1,
    execTimeoutMs: 1,
    healthDeepCacheMs: 0,
    imageCacheEnabled: true,
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 7 * 24 * 60 * 60_000,
    sandboxCiTtlMs: 6 * 60 * 60_000,
    sandboxOrphanGraceMs: 1_800_000,
    sandboxBrokenRecycleGraceMs: 300_000,
    maxRunningSandboxes: 8,
    warnRunningSandboxes: 6,
    drainDeadlineMs: 120_000,
    networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    snat: {
      mode: 'disabled',
      aliyunCliPath: 'aliyun',
      entryNamePrefix: 'agent-saas-acs',
      maxManagedEntries: 12,
      requestTimeoutMs: 1,
      stabilizeAfterCreateMs: 0,
      statusCacheMs: 0,
    },
    alertWebhookUrls: [],
    alertMinIntervalMs: 300_000,
    capabilities: {
      browser: true,
      media: true,
      officeDocuments: true,
      pythonBasePackages: true,
    },
    egress: {
      proxy: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    },
    logLevel: 'info',
  };
}

describe('spawnRunner 命令构造（A 方案批次 3：预编译 sandboxRunner）', () => {
  it('优先跑预编译产物，缺失时退回 tsx', async () => {
    const ref: SandboxRef = {
      name: 'as-active',
      workspaceId: 'ws_kaiyan__u-1',
      sandboxScopeId: 'ws_kaiyan__u-1__s_top',
      sessionId: 'session-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
    };
    const child = fakeChild();
    const sandboxManager = {
      ref: () => ref,
      ensureRunning: vi.fn(async () => ref),
    } as unknown as SandboxManager;
    const spawn = vi.fn(() => child);
    const kubectl = { spawn } as unknown as Kubectl;
    const executor = new AcsExecutor(baseConfig(), kubectl, sandboxManager, noopLogger);

    const iterator = executor.executeStream({
      toolName: 'Read',
      input: { file_path: '/workspace/a.txt' },
      context: {
        invocationId: 'inv-precompiled',
        workspace: {
          id: ref.workspaceId,
          sessionId: ref.sessionId,
          sandboxScopeId: ref.sandboxScopeId,
          mountSubPath: ref.mountSubPath,
        },
      },
    }, { stream: true })[Symbol.asyncIterator]();
    await iterator.next().catch(() => undefined);

    expect(spawn).toHaveBeenCalled();
    const firstCall = spawn.mock.calls[0] as unknown as [string[], unknown];
    const args = firstCall[0];
    const script = args.join(' ');
    // 用 sh -c 做运行期存在性判断，而非把路径写死：蓝绿/回滚期间可能短暂跑到
    // 不含预编译产物的旧镜像，此时必须能退回 tsx（宁可慢，不可不可用）。
    expect(args).toContain('/bin/sh');
    expect(script).toContain('dist/sandboxRunner.mjs');
    expect(script).toContain('src/sandboxRunner.ts');
    expect(script.indexOf('dist/sandboxRunner.mjs')).toBeLessThan(script.indexOf('node_modules/.bin/tsx'));
  });
});
