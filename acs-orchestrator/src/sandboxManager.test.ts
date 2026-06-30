import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';

describe('SandboxManager', () => {
  it('writes configured imagePullSecrets into the Sandbox pod template', async () => {
    let applied: Record<string, unknown> | undefined;
    let created = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') {
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'apply') {
          applied = JSON.parse(options.input ?? '{}') as Record<string, unknown>;
          created = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      imagePullSecretNames: ['acr-agentsaasacrprod'],
    }, kubectl, noopLogger);

    await manager.ensureRunning({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    const podSpec = (((applied?.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>);
    const container = (podSpec.containers as Array<Record<string, unknown>>)[0]!;
    expect(podSpec.imagePullSecrets).toEqual([{ name: 'acr-agentsaasacrprod' }]);
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'ACS_WORKSPACE_PATH', value: '/workspace' },
      { name: 'ACS_SANDBOX_IMAGE', value: 'registry.example.com/agent-saas/acs-sandbox:test' },
      { name: 'DOWNLOAD_DIR', value: '/workspace/downloads' },
      { name: 'XDG_DOWNLOAD_DIR', value: '/workspace/downloads' },
      { name: 'VIRTUAL_ENV', value: '/workspace/.ky-agent/runtime/venv' },
      { name: 'PIP_CACHE_DIR', value: '/workspace/.ky-agent/runtime/cache/pip' },
      { name: 'PIP_DISABLE_PIP_VERSION_CHECK', value: '1' },
      { name: 'PIP_REQUIRE_VIRTUALENV', value: '1' },
      { name: 'PATH', value: '/workspace/.ky-agent/runtime/venv/bin:/home/agent/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin' },
      { name: 'FORCE_COLOR', value: '0' },
      { name: 'TZ', value: 'Asia/Shanghai' },
      { name: 'LANG', value: 'C.UTF-8' },
      { name: 'LC_ALL', value: 'C.UTF-8' },
    ]));
    expect(container.command).toEqual(['/bin/sh', '-c', 'mkdir -p "$ACS_WORKSPACE_PATH" "$DOWNLOAD_DIR" && cd "$ACS_WORKSPACE_PATH" && sleep infinity']);
    expect(container.volumeMounts).toMatchObject([{
      name: 'workspace',
      mountPath: '/workspace',
      subPath: 'workspaces/kaiyan/u-1',
    }]);
    expect(podSpec).toMatchObject({
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 501,
        runAsGroup: 20,
      },
    });
    expect(container.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 501,
      runAsGroup: 20,
      allowPrivilegeEscalation: false,
    });
    expect((applied?.metadata as Record<string, unknown>).labels).toMatchObject({
      'agent-saas.kaiyan.net/network-policy-mode': 'public-egress',
    });
    expect((applied?.metadata as Record<string, unknown>).annotations).toMatchObject({
      'agent-saas.kaiyan.net/workspace-id': 'ws_kaiyan__test',
      'agent-saas.kaiyan.net/session-id': 'session-123',
      'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
      'agent-saas.kaiyan.net/network-policy-mode': 'public-egress',
      'agent-saas.kaiyan.net/network-policy-deny-private': 'true',
      'network.alibabacloud.com/enable-network-policy-agent': 'true',
      'network.alibabacloud.com/network-policy-mode': 'traffic-policy',
    });
    expect((((applied?.spec as Record<string, unknown>).template as Record<string, unknown>).metadata as Record<string, unknown>).annotations).toMatchObject({
      'network.alibabacloud.com/enable-network-policy-agent': 'true',
      'network.alibabacloud.com/network-policy-mode': 'traffic-policy',
    });
  });

  it('prepares runtime directories for the non-root sandbox user', async () => {
    let created = false;
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        if (args[0] === 'apply') {
          created = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const hostWorkspaceRoot = await mkdtemp(join(tmpdir(), 'acs-workspace-'));
    const uid = process.getuid?.() ?? 501;
    const gid = process.getgid?.() ?? 20;
    try {
      const manager = new SandboxManager({
        ...baseConfig(),
        hostWorkspaceRoot,
        sandboxRunAsUser: uid,
        sandboxRunAsGroup: gid,
      }, kubectl, noopLogger);

      await manager.ensureRunning({
        workspaceId: 'ws_kaiyan__test',
        sessionId: 'session-123',
        mountSubPath: 'workspaces/kaiyan/u-1',
      });

      const workspacePath = join(hostWorkspaceRoot, 'workspaces/kaiyan/u-1');
      await expect(stat(join(workspacePath, '.ky-agent', 'runtime', 'venv-archive'))).resolves.toMatchObject({
        uid,
        gid,
      });
      await expect(stat(join(workspacePath, '.ky-agent', 'runtime', 'cache', 'pip'))).resolves.toMatchObject({
        uid,
        gid,
      });
      expect((await stat(workspacePath)).mode & 0o777).toBe(0o775);
      expect((await stat(join(workspacePath, '.ky-agent'))).mode & 0o777).toBe(0o770);
      expect((await stat(join(workspacePath, '.ky-agent', 'runtime'))).mode & 0o777).toBe(0o770);
      expect((await stat(join(workspacePath, '.ky-agent', 'runtime', 'cache'))).mode & 0o777).toBe(0o770);
      expect((await stat(join(workspacePath, '.ky-agent', 'runtime', 'provision'))).mode & 0o777).toBe(0o770);
      expect((await stat(join(workspacePath, 'downloads'))).mode & 0o777).toBe(0o775);
    } finally {
      await rm(hostWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it('recreates an existing Sandbox when the image tag drifts', async () => {
    const deleted: string[] = [];
    let sandboxApplied = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') {
          if (!sandboxApplied) {
            return {
              stdout: JSON.stringify({
                status: { phase: 'Paused' },
                spec: {
                  template: {
                    spec: {
                      containers: [{ name: 'sandbox', image: 'registry.example.com/agent-saas/acs-sandbox:old' }],
                    },
                  },
                },
                metadata: {
                  annotations: {
                    'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
                  },
                },
              }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'delete') {
          deleted.push(args[1] ?? '');
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string };
          if (manifest.kind === 'Sandbox') sandboxApplied = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger);

    await manager.ensureRunning({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    expect(deleted.some((name) => name.startsWith('sandbox/as-session-123-'))).toBe(true);
    expect(sandboxApplied).toBe(true);
  });

  it('rejects creating a new Sandbox when running quota is exhausted', async () => {
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [{
                metadata: {
                  name: 'as-other',
                  annotations: {
                    'agent-saas.kaiyan.net/created-at': '2026-06-27T00:00:00.000Z',
                    'agent-saas.kaiyan.net/last-active-at': '2026-06-27T00:00:00.000Z',
                  },
                },
                status: { phase: 'Running' },
              }],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'get') return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      maxRunningSandboxes: 1,
      lifecycleEnabled: false,
    }, kubectl, noopLogger);

    await expect(manager.ensureRunning({ workspaceId: 'ws_kaiyan__test', sessionId: 'session-123' }))
      .rejects.toThrow(/running quota exceeded/);
  });

  it('reclaims idle Sandboxes before enforcing running quota', async () => {
    const calls: string[][] = [];
    let idlePaused = false;
    let created = false;
    let applied: Record<string, unknown> | undefined;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [{
                metadata: {
                  name: 'as-idle',
                  annotations: {
                    'agent-saas.kaiyan.net/created-at': '2026-06-27T00:00:00.000Z',
                    'agent-saas.kaiyan.net/last-active-at': '2026-06-27T00:00:00.000Z',
                  },
                },
                status: { phase: idlePaused ? 'Paused' : 'Running' },
              }],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') {
          if (args[1] === 'sandbox/as-idle') idlePaused = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'apply') {
          applied = JSON.parse(options.input ?? '{}') as Record<string, unknown>;
          created = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      maxRunningSandboxes: 1,
      sandboxIdlePauseMs: 1,
      sandboxTtlMs: 0,
    }, kubectl, noopLogger);

    await manager.ensureRunning({ workspaceId: 'ws_kaiyan__test', sessionId: 'session-123' });

    expect(applied).toBeTruthy();
    expect(calls.some((args) => args[0] === 'patch' && args[1] === 'sandbox/as-idle')).toBe(true);
  });

  it('force-pauses the oldest non-busy Sandbox when quota is still exhausted', async () => {
    const calls: string[][] = [];
    let oldPaused = false;
    let created = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                {
                  metadata: {
                    name: 'as-old',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2099-06-27T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2099-06-27T00:01:00.000Z',
                    },
                  },
                  status: { phase: oldPaused ? 'Paused' : 'Running' },
                },
                {
                  metadata: {
                    name: 'as-busy',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2099-06-27T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2099-06-27T00:02:00.000Z',
                    },
                  },
                  status: { phase: 'Running' },
                },
              ],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') {
          if (args[1] === 'sandbox/as-old') oldPaused = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'apply') {
          JSON.parse(options.input ?? '{}') as Record<string, unknown>;
          created = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      maxRunningSandboxes: 2,
      sandboxIdlePauseMs: 60 * 60_000,
      sandboxTtlMs: 0,
    }, kubectl, noopLogger);

    await manager.ensureRunning(
      { workspaceId: 'ws_kaiyan__test', sessionId: 'session-123' },
      { busySandboxNames: new Set(['as-busy']) },
    );

    expect(calls.some((args) => args[0] === 'patch' && args[1] === 'sandbox/as-old')).toBe(true);
    expect(calls.some((args) => args[0] === 'patch' && args[1] === 'sandbox/as-busy')).toBe(false);
  });

  it('pauses idle running Sandboxes and deletes expired Sandboxes without touching workspaces', async () => {
    const calls: string[][] = [];
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                {
                  metadata: {
                    name: 'as-idle',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-27T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-27T00:10:00.000Z',
                    },
                  },
                  status: { phase: 'Running' },
                },
                {
                  metadata: {
                    name: 'as-expired',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-26T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-26T00:10:00.000Z',
                    },
                  },
                  status: { phase: 'Paused' },
                },
                {
                  metadata: {
                    name: 'as-busy',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-26T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-26T00:10:00.000Z',
                    },
                  },
                  status: { phase: 'Running' },
                },
              ],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'patch' || args[0] === 'delete') {
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxIdlePauseMs: 5 * 60_000,
      sandboxTtlMs: 6 * 60 * 60_000,
    }, kubectl, noopLogger);

    const report = await manager.cleanupSandboxes({
      now: new Date('2026-06-27T00:20:00.000Z'),
      busySandboxNames: new Set(['as-busy']),
    });

    expect(report.paused).toEqual(['as-idle']);
    expect(report.deleted).toEqual(['as-expired']);
    expect(report.skippedBusy).toEqual(['as-busy']);
    expect(calls.some((args) => args[0] === 'patch' && args[1] === 'sandbox/as-idle')).toBe(true);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === 'sandbox/as-expired')).toBe(true);
  });
});

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
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 21_600_000,
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
