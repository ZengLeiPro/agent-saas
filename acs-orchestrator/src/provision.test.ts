import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { Provisioner } from './provision.js';
import type { SandboxManager } from './sandboxManager.js';

describe('Provisioner runtime bootstrap', () => {
  it('runs sandbox runtime bootstrap before marking provision ok', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const kubectl = kubectlStub(calls);
    const provisioner = new Provisioner(baseConfig(), kubectl, sandboxManagerStub(), () => new Set());

    const result = await provisioner.provision({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    expect(result.status).toBe('ok');
    expect(result.logs.map((log) => log.step)).toEqual([
      'sandbox_ensure',
      'runtime_bootstrap',
    ]);
    const bootstrap = calls.find((call) => call.args.includes('/app/acs-orchestrator/src/sandboxRunner.ts'));
    expect(bootstrap).toBeTruthy();
    expect(bootstrap?.args).toEqual([
      'exec',
      '-i',
      'as-session-123',
      '-c',
      'sandbox',
      '--',
      '/app/acs-orchestrator/node_modules/.bin/tsx',
      '/app/acs-orchestrator/src/sandboxRunner.ts',
    ]);
    const bootstrapInput = JSON.parse(bootstrap?.input ?? '{}');
    expect(bootstrapInput).toMatchObject({
      toolName: 'Shell',
      workspace: { root: '/workspace' },
    });
    expect(bootstrapInput.input.command).toContain('duckdb -json -c "select 1 as ok"');
  });

  it('does not skip runtime bootstrap when recipe hash is already provisioned', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const kubectl = kubectlStub(calls, {
      existingProvisionHash: createHash('sha256').update(JSON.stringify({
        workspaceId: 'ws_kaiyan__test',
      })).digest('hex'),
    });
    const provisioner = new Provisioner(baseConfig(), kubectl, sandboxManagerStub(), () => new Set());

    const result = await provisioner.provision({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
    });

    expect(result.status).toBe('ok');
    expect(result.logs.map((log) => log.step)).toEqual([
      'sandbox_ensure',
      'runtime_bootstrap',
      'provision_idempotency',
    ]);
    expect(calls.find((call) => call.args.includes('/app/acs-orchestrator/src/sandboxRunner.ts'))).toBeTruthy();
  });

  it('coalesces concurrent provisions for the same sandbox and recipe', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    let releaseBootstrap!: () => void;
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    let bootstrapStarted = 0;
    const kubectl = kubectlStub(calls, {
      onBootstrap: async () => {
        bootstrapStarted += 1;
        await bootstrapGate;
      },
    });
    const provisioner = new Provisioner(baseConfig(), kubectl, sandboxManagerStub(), () => new Set());

    const first = provisioner.provision({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });
    const second = provisioner.provision({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-456',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    await waitFor(() => bootstrapStarted === 1);
    releaseBootstrap();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('ok');
    expect(secondResult.status).toBe('ok');
    expect(secondResult.logs[0]).toMatchObject({
      step: 'provision_singleflight',
      status: 'skipped',
    });
    expect(calls.filter((call) => call.args.includes('/app/acs-orchestrator/src/sandboxRunner.ts'))).toHaveLength(1);
  });
});

function sandboxManagerStub(): SandboxManager {
  return {
    ref() {
      return {
        name: 'as-session-123',
        workspaceId: 'ws_kaiyan__test',
        sandboxScopeId: 'ws_kaiyan__test',
        sessionId: 'session-123',
        mountSubPath: 'workspaces/kaiyan/u-1',
      };
    },
    async ensureRunning() {
      return {
        name: 'as-session-123',
        workspaceId: 'ws_kaiyan__test',
        sandboxScopeId: 'ws_kaiyan__test',
        sessionId: 'session-123',
        mountSubPath: 'workspaces/kaiyan/u-1',
      };
    },
  } as unknown as SandboxManager;
}

function kubectlStub(
  calls: Array<{ args: string[]; input?: string }>,
  options: { existingProvisionHash?: string; onBootstrap?: () => void | Promise<void> } = {},
): Kubectl {
  return {
    async run(args: string[], runOptions: { input?: string } = {}): Promise<KubectlResult> {
      calls.push({ args, input: runOptions.input });
      const joinedArgs = args.join('\n');
      if (args.includes('/app/acs-orchestrator/src/sandboxRunner.ts')) {
        await options.onBootstrap?.();
        return {
          stdout: JSON.stringify({
            kind: 'final',
            response: { status: 'success', content: 'PYTHON_VENV_READY\nACS_RUNTIME_BOOTSTRAP_OK\n' },
          }) + '\n',
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      if (joinedArgs.includes('cat .ky-agent/runtime/provision/provision-hash 2>/dev/null || true')) {
        return { stdout: options.existingProvisionHash ?? '', stderr: '', exitCode: 0, signal: null };
      }
      if (joinedArgs.includes('mkdir -p .ky-agent/runtime/provision && printf %s')) {
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      }
      throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
    },
  } as unknown as Kubectl;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

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
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 7 * 24 * 60 * 60_000,
    sandboxOrphanGraceMs: 1_800_000,
    maxRunningSandboxes: 8,
    warnRunningSandboxes: 6,
    networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    snat: {
      mode: 'disabled',
      aliyunCliPath: 'aliyun',
      entryNamePrefix: 'agent-saas-acs',
      maxManagedEntries: 12,
      requestTimeoutMs: 1,
      stabilizeAfterCreateMs: 0,
    },
    alertMinIntervalMs: 300_000,
    capabilities: {
      browser: true,
      media: true,
      officeDocuments: true,
      pythonBasePackages: true,
    },
    logLevel: 'info',
  };
}
