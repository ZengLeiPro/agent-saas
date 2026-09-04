import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { Provisioner } from './provision.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from 'server/runtime/runtimeIsolationEvidence.js';
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
    expect(bootstrapInput.input.command).toContain('BROWSER_PYTHON=/opt/ky-agent/browser-runtime/bin/python3');
    expect(bootstrapInput.input.command).toContain('if [ ! -e "$BROWSER_PYTHON" ]; then BROWSER_PYTHON="$(command -v python3)"; fi');
    expect(bootstrapInput.input.command).toContain('from playwright.sync_api import sync_playwright');
    expect(bootstrapInput.input.command).toContain('assert executable.is_file(), executable');
    expect(bootstrapInput.input.command).toContain('p.chromium.launch(headless=True, channel="chromium"');
    expect(bootstrapInput.input.command).toContain('browser.close()');
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

  it('attests the exact SandboxRef returned by ensureRunning and binds every run identity field', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const manager = sandboxManagerStub();
    const probe = vi.spyOn(manager, 'probeNetworkPolicyForRef');
    const provisioner = new Provisioner(baseConfig(), kubectlStub(calls), manager, () => new Set());
    const requirement = {
      tenantId: 'tenant-1', taskId: 'task-1', runId: 'run-1', sessionId: 'session-123',
      workspaceId: 'ws_kaiyan__test', policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    };

    const result = await provisioner.provision({
      workspaceId: requirement.workspaceId,
      sessionId: requirement.sessionId,
      mountSubPath: 'workspaces/kaiyan/u-1',
      runtimeIsolationRequirement: requirement,
    });

    expect(result.status).toBe('ok');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ name: 'as-session-123' }));
    expect(result.metadata.runtimeIsolationEvidence).toMatchObject({
      ...requirement,
      sandboxName: 'as-session-123',
      sandboxScopeId: 'ws_kaiyan__test',
    });
  });

  it('passes the Agent shared read-only mount through both SandboxRef boundaries', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const manager = sandboxManagerStub();
    const ref = vi.spyOn(manager, 'ref');
    const ensureRunning = vi.spyOn(manager, 'ensureRunning');
    const provisioner = new Provisioner(baseConfig(), kubectlStub(calls), manager, () => new Set());

    await provisioner.provision({
      workspaceId: 'task-workspace', sessionId: 'session-123',
      sandboxScopeId: 'task-scope', mountSubPath: 'workspaces/agent/work/task/attempt-1',
      sharedReadOnlySubPath: 'workspaces/agent/shared/binding/topic',
    });

    expect(ref).toHaveBeenCalledWith(expect.objectContaining({
      sharedReadOnlySubPath: 'workspaces/agent/shared/binding/topic',
    }));
    expect(ensureRunning).toHaveBeenCalledWith(expect.objectContaining({
      sharedReadOnlySubPath: 'workspaces/agent/shared/binding/topic',
    }), expect.any(Object));
  });

  it('fails closed when the actual runtime SandboxRef breaks an isolation condition', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const manager = sandboxManagerStub();
    vi.spyOn(manager, 'probeNetworkPolicyForRef').mockResolvedValueOnce(validPolicy({ metadataExitCode: 0 }));
    const provisioner = new Provisioner(baseConfig(), kubectlStub(calls), manager, () => new Set());

    const result = await provisioner.provision({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      runtimeIsolationRequirement: {
        tenantId: 'tenant-1', taskId: 'task-1', runId: 'run-1', sessionId: 'session-123',
        workspaceId: 'ws_kaiyan__test', policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
      },
    });

    expect(result).toMatchObject({ status: 'error', error: 'actual runtime sandbox isolation is not enforced' });
    expect(result.metadata).not.toHaveProperty('runtimeIsolationEvidence');
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
    async probeNetworkPolicyForRef() {
      return validPolicy();
    },
  } as unknown as SandboxManager;
}

function validPolicy(options: { metadataExitCode?: number } = {}) {
  const blocked = { exitCode: 1, signal: null, stdout: '', stderr: 'blocked' };
  return {
    desiredPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    effectivePolicy: {
      enforcement: 'enforced', privateEgressBlocked: true, metadataBlocked: true,
      dnsRebindingProtected: true,
    },
    probe: {
      checks: {
        publicRegistry: { exitCode: 0, signal: null, stdout: 'ok', stderr: '' },
        metadata: { ...blocked, exitCode: options.metadataExitCode ?? 1 },
        privateApi: blocked,
        dnsRebinding: blocked,
      },
    },
  } as any;
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
    healthDeepCacheMs: 0,
    imageCacheEnabled: true,
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 7 * 24 * 60 * 60_000,
    sandboxOrphanGraceMs: 1_800_000,
    sandboxBrokenRecycleGraceMs: 300_000,
    maxRunningSandboxes: 8,
    warnRunningSandboxes: 6,
    maxAllocatedCpuMillicores: 0,
    warnAllocatedCpuMillicores: 0,
    maxAllocatedMemoryMib: 0,
    warnAllocatedMemoryMib: 0,
    executionMaintenance: false,
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
