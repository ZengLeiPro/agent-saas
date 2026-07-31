import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager, brokenSandboxStateReason } from './sandboxManager.js';

describe('SandboxManager egress injection', () => {
  async function applyWithEgress(egress: AcsOrchestratorConfig['egress']) {
    const applies: Array<Record<string, unknown>> = [];
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
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        if (args[0] === 'apply') {
          applies.push(JSON.parse(options.input ?? '{}') as Record<string, unknown>);
          created = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({ ...baseConfig(), egress }, kubectl, noopLogger);
    await manager.ensureRunning({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    const sandbox = applies.find((item) => item.kind === 'Sandbox');
    const trafficPolicy = applies.find((item) => item.kind === 'TrafficPolicy');
    const podSpec = ((sandbox?.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>;
    const container = (podSpec.containers as Array<Record<string, unknown>>)[0]!;
    return {
      env: container.env as Array<{ name: string; value: string }>,
      annotations: (sandbox?.metadata as Record<string, unknown>).annotations as Record<string, string>,
      trafficRules: ((trafficPolicy?.spec as any)?.egress?.rules ?? []) as any[],
    };
  }

  it('未启用时 Pod env 不含任何代理/镜像源变量', async () => {
    const { env } = await applyWithEgress({
      proxy: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    });
    const names = env.map((entry) => entry.name);
    expect(names.filter((name) => /proxy/i.test(name))).toEqual([]);
    expect(names).not.toContain('PIP_INDEX_URL');
    expect(names).not.toContain('NPM_CONFIG_REGISTRY');
  });

  it('启用代理时大小写各注一份（Chromium/curl 认小写，Go 二进制认大写）', async () => {
    const { env, annotations } = await applyWithEgress({
      proxy: { enabled: true, proxyUrl: 'http://172.16.177.77:7890', noProxy: ['internal.example.com'] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    });
    const byName = Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
    expect(byName.HTTP_PROXY).toBe('http://172.16.177.77:7890');
    expect(byName.http_proxy).toBe('http://172.16.177.77:7890');
    expect(byName.HTTPS_PROXY).toBe('http://172.16.177.77:7890');
    expect(byName.https_proxy).toBe('http://172.16.177.77:7890');
    // VPC DNS 必须在 NO_PROXY 里，否则容器 DNS 会整体走代理并失败
    expect(byName.NO_PROXY).toContain('100.100.2.136');
    expect(byName.no_proxy).toBe(byName.NO_PROXY);
    expect(byName.NO_PROXY).toContain('internal.example.com');
    expect(annotations['agent-saas.kaiyan.net/egress-fingerprint']).toContain('HTTP_PROXY=');
  });

  it('启用镜像源时注入 pip/npm 源，且与代理相互独立', async () => {
    const { env } = await applyWithEgress({
      proxy: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: {
        enabled: true,
        pipIndexUrl: 'https://mirrors.aliyun.com/pypi/simple/',
        pipTrustedHost: 'mirrors.aliyun.com',
        npmRegistry: 'https://registry.npmmirror.com',
      },
    });
    const byName = Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
    expect(byName.PIP_INDEX_URL).toBe('https://mirrors.aliyun.com/pypi/simple/');
    expect(byName.NPM_CONFIG_REGISTRY).toBe('https://registry.npmmirror.com');
    expect(Object.keys(byName).filter((name) => /proxy/i.test(name))).toEqual([]);
  });

  it('启用代理时 TrafficPolicy 自动放行代理 IP，且排在私网 deny 之前', async () => {
    const { trafficRules } = await applyWithEgress({
      proxy: { enabled: true, proxyUrl: 'http://172.16.177.77:7890', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    });
    const allowIndex = trafficRules.findIndex(
      (rule) => rule.action === 'allow' && rule.to?.some((peer: any) => peer.cidr === '172.16.177.77/32'),
    );
    const denyIndex = trafficRules.findIndex(
      (rule) => rule.action === 'deny' && rule.to?.some((peer: any) => peer.cidr === '172.16.0.0/12'),
    );
    expect(allowIndex).toBeGreaterThanOrEqual(0);
    expect(denyIndex).toBeGreaterThanOrEqual(0);
    expect(allowIndex).toBeLessThan(denyIndex);
  });
});

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
      'agent-saas.kaiyan.net/sandbox-scope-id': 'ws_kaiyan__test',
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

  it('refreshes a paused image-drift Sandbox in place when only the current active key is using it', async () => {
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

    const activeRegistry = new ActiveSandboxRegistry();
    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger, activeRegistry);
    const activeKey = 'current-invocation';
    const ref = manager.ref({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });
    const release = activeRegistry.acquire(ref.name, activeKey);

    try {
      await manager.ensureRunning({
        workspaceId: 'ws_kaiyan__test',
        sessionId: 'session-123',
        mountSubPath: 'workspaces/kaiyan/u-1',
      }, { activeKey });
    } finally {
      release();
    }

    expect(deleted.some((name) => name.startsWith('sandbox/as-ws-kaiyan-test-'))).toBe(false);
    expect(sandboxApplied).toBe(true);
  });

  it('refuses to recreate a busy shared Sandbox when the image tag drifts', async () => {
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        if (args[0] === 'get') {
          return {
            stdout: JSON.stringify({
              status: { phase: 'Running' },
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
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger);
    const busyName = manager.ref({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    }).name;

    await expect(manager.ensureRunning(
      { workspaceId: 'ws_kaiyan__test', sessionId: 'session-456', mountSubPath: 'workspaces/kaiyan/u-1' },
      { busySandboxNames: new Set([busyName]) },
    )).rejects.toThrow(/refuse to recreate while active/);
  });

  it('recreates a broken Paused Sandbox instead of waiting for resume forever', async () => {
    const calls: string[][] = [];
    const currentImage = 'registry.example.com/agent-saas/acs-sandbox:test';
    let state: 'broken' | 'running' = 'broken';
    let appliedSandbox = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') {
          if (state === 'broken') {
            return {
              stdout: JSON.stringify({
                metadata: {
                  annotations: {
                    'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
                  },
                },
                spec: {
                  paused: false,
                  template: {
                    spec: {
                      containers: [{ name: 'sandbox', image: currentImage }],
                    },
                  },
                },
                status: {
                  phase: 'Paused',
                  conditions: [{
                    type: 'SandboxPaused',
                    status: 'False',
                    reason: 'ImageChanged',
                    message: 'pause is not allowed',
                  }],
                  podInfo: {
                    annotations: {
                      'ops.alibabacloud.com/recreating': 'true',
                    },
                  },
                },
              }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          return {
            stdout: JSON.stringify({
              metadata: {
                annotations: {
                  'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
                },
              },
              spec: {
                paused: false,
                template: { spec: { containers: [{ name: 'sandbox', image: currentImage }] } },
              },
              status: { phase: 'Running' },
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'delete') {
          if (args[1]?.startsWith('sandbox/')) state = 'running';
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string };
          if (manifest.kind === 'Sandbox') {
            appliedSandbox = true;
            state = 'running';
          }
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxImage: currentImage,
    }, kubectl, noopLogger);

    const ref = manager.ref({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    await manager.ensureRunning({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    expect(calls.some((args) => args[0] === 'delete' && args[1] === `sandbox/${ref.name}`)).toBe(true);
    expect(appliedSandbox).toBe(true);
    expect(calls.some((args) => args[0] === 'patch' && args[1] === `sandbox/${ref.name}` && String(args[4] ?? '').includes('"paused":false'))).toBe(false);
  });

  it('recreates a Failed Sandbox with missing pod instead of waiting until provision timeout', async () => {
    const calls: string[][] = [];
    const currentImage = 'registry.example.com/agent-saas/acs-sandbox:test';
    let state: 'failed' | 'running' = 'failed';
    let appliedSandbox = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') {
          if (state === 'failed') {
            return {
              stdout: JSON.stringify({
                metadata: {
                  annotations: {
                    'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
                  },
                },
                spec: {
                  paused: false,
                  template: { spec: { containers: [{ name: 'sandbox', image: currentImage }] } },
                },
                status: {
                  phase: 'Failed',
                  message: 'Pod Not Found',
                  podInfo: {
                    annotations: {
                      'ops.alibabacloud.com/recreating': 'true',
                    },
                  },
                },
              }),
              stderr: '',
              exitCode: 0,
              signal: null,
            };
          }
          return {
            stdout: JSON.stringify({
              metadata: {
                annotations: {
                  'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
                },
              },
              spec: {
                paused: false,
                template: { spec: { containers: [{ name: 'sandbox', image: currentImage }] } },
              },
              status: { phase: 'Running' },
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'delete') {
          if (args[1]?.startsWith('sandbox/')) state = 'running';
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string };
          if (manifest.kind === 'Sandbox') {
            appliedSandbox = true;
            state = 'running';
          }
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxImage: currentImage,
    }, kubectl, noopLogger);

    const ref = manager.ref({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    await manager.ensureRunning({
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-123',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });

    expect(calls.some((args) => args[0] === 'delete' && args[1] === `sandbox/${ref.name}`)).toBe(true);
    expect(appliedSandbox).toBe(true);
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

  it('pauses idle running Sandboxes and deletes Sandboxes unused past TTL without touching workspaces', async () => {
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
                      'agent-saas.kaiyan.net/created-at': '2026-06-20T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-20T00:10:00.000Z',
                    },
                  },
                  status: { phase: 'Paused' },
                },
                {
                  metadata: {
                    name: 'as-busy',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-20T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-20T00:10:00.000Z',
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
      sandboxTtlMs: 7 * 24 * 60 * 60_000,
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

  it('keeps a sandbox running while a durable background shell protection is active', async () => {
    const calls: string[][] = [];
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [{
                metadata: {
                  name: 'as-background-shell',
                  annotations: {
                    'agent-saas.kaiyan.net/created-at': '2026-07-19T00:00:00.000Z',
                    'agent-saas.kaiyan.net/last-active-at': '2026-07-19T00:00:00.000Z',
                    'agent-saas.kaiyan.net/background-shell-protected-until': '2026-07-20T00:00:00.000Z',
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
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxIdlePauseMs: 5 * 60_000,
      sandboxTtlMs: 60 * 60_000,
    }, kubectl, noopLogger);

    const report = await manager.cleanupSandboxes({ now: new Date('2026-07-19T12:00:00.000Z') });

    expect(report.paused).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.skippedBusy).toEqual(['as-background-shell']);
    expect(calls).toHaveLength(1);
  });

  it('does not delete Sandboxes older than TTL when they were recently active', async () => {
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
                    name: 'as-recently-active',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-19T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-27T00:10:00.000Z',
                    },
                  },
                  status: { phase: 'Paused' },
                },
              ],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'delete') {
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxTtlMs: 7 * 24 * 60 * 60_000,
    }, kubectl, noopLogger);

    const report = await manager.cleanupSandboxes({
      now: new Date('2026-06-27T00:20:00.000Z'),
    });

    expect(report.deleted).toEqual([]);
    expect(calls.some((args) => args[0] === 'delete')).toBe(false);
  });

  it('does not pause or delete active Sandboxes from lifecycle or workspace deletion', async () => {
    const calls: string[][] = [];
    const activeRegistry = new ActiveSandboxRegistry();
    const release = activeRegistry.acquire('as-active', 'invocation-1');
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [{
                metadata: {
                  name: 'as-active',
                  annotations: {
                    'agent-saas.kaiyan.net/workspace-id': 'ws_kaiyan__test',
                    'agent-saas.kaiyan.net/created-at': '2026-06-26T00:00:00.000Z',
                    'agent-saas.kaiyan.net/last-active-at': '2026-06-26T00:10:00.000Z',
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
        if (args[0] === 'patch' || args[0] === 'delete') {
          throw new Error(`active sandbox should not be mutated: ${args.join(' ')}`);
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    try {
      const manager = new SandboxManager({
        ...baseConfig(),
        sandboxIdlePauseMs: 1,
        sandboxTtlMs: 1,
      }, kubectl, noopLogger, activeRegistry);

      const report = await manager.cleanupSandboxes({ now: new Date('2026-06-27T00:20:00.000Z') });
      const deleted = await manager.deleteByWorkspaceId('ws_kaiyan__test');

      expect(report.skippedBusy).toEqual(['as-active']);
      expect(report.paused).toEqual([]);
      expect(report.deleted).toEqual([]);
      expect(deleted).toEqual({ names: [], skippedBusy: ['as-active'] });
      expect(calls.some((args) => args[0] === 'patch')).toBe(false);
      expect(calls.some((args) => args[0] === 'delete')).toBe(false);
    } finally {
      release();
    }
  });

  it('listSandboxInventory: annotates busy, stale image, TTL, and broken paused reason', async () => {
    const activeRegistry = new ActiveSandboxRegistry();
    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxTtlMs: 60 * 60_000,
    }, {
      async run(args: string[]): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [{
                metadata: {
                  name: 'as-broken',
                  annotations: {
                    'agent-saas.kaiyan.net/workspace-id': 'ws_kaiyan__u-1',
                    'agent-saas.kaiyan.net/session-id': 'session-1',
                    'agent-saas.kaiyan.net/sandbox-scope-id': 'ws_kaiyan__u-1',
                    'agent-saas.kaiyan.net/created-at': '2026-07-06T00:00:00.000Z',
                    'agent-saas.kaiyan.net/last-active-at': '2026-07-06T00:20:00.000Z',
                  },
                },
                spec: {
                  paused: false,
                  template: {
                    spec: {
                      containers: [{ name: 'sandbox', image: 'registry.example.com/agent-saas/acs-sandbox:old' }],
                    },
                  },
                },
                status: {
                  phase: 'Paused',
                  conditions: [{ type: 'SandboxPaused', reason: 'ImageChanged', status: 'False' }],
                },
              }],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl, noopLogger, activeRegistry);
    const release = activeRegistry.acquire('as-broken', 'invocation-1');

    try {
      const result = await manager.listSandboxInventory({
        now: new Date('2026-07-06T00:30:00.000Z'),
      });

      expect(result).toMatchObject([{
        name: 'as-broken',
        workspaceId: 'ws_kaiyan__u-1',
        phase: 'Paused',
        brokenReason: 'image_changed',
        busy: true,
        imageStale: true,
        idleMs: 10 * 60_000,
        effectiveTtlMs: 60 * 60_000,
        ttlRemainingMs: 50 * 60_000,
      }]);
    } finally {
      release();
    }
  });

  it('manual pause/resume/delete reject active Sandboxes with 409-class errors', async () => {
    const calls: string[][] = [];
    const activeRegistry = new ActiveSandboxRegistry();
    const release = activeRegistry.acquire('as-active', 'invocation-1');
    const manager = new SandboxManager(baseConfig(), {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      },
    } as unknown as Kubectl, noopLogger, activeRegistry);

    try {
      await expect(manager.pauseByName('as-active')).rejects.toMatchObject({ statusCode: 409 });
      await expect(manager.resumeByName('as-active')).rejects.toMatchObject({ statusCode: 409 });
      await expect(manager.deleteByName('as-active')).rejects.toMatchObject({ statusCode: 409 });
      expect(calls).toEqual([]);
    } finally {
      release();
    }
  });

  it('resumeByName rebuilds the ref from Sandbox annotations and delegates to ensureRunning', async () => {
    const calls: string[][] = [];
    let phase = 'Paused';
    const manager = new SandboxManager({
      ...baseConfig(),
      maxRunningSandboxes: 0,
      sandboxWaitTimeoutMs: 50,
    }, {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1]?.startsWith('sandbox/')) {
          return {
            stdout: JSON.stringify({
              metadata: {
                name: args[1].slice('sandbox/'.length),
                annotations: {
                  'agent-saas.kaiyan.net/workspace-id': 'ws_kaiyan__u-1',
                  'agent-saas.kaiyan.net/session-id': 'session-1',
                  'agent-saas.kaiyan.net/sandbox-scope-id': 'ws_kaiyan__u-1',
                  'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1',
                },
              },
              spec: {
                template: {
                  spec: {
                    containers: [{ name: 'sandbox', image: 'registry.example.com/agent-saas/acs-sandbox:test' }],
                  },
                },
              },
              status: { phase },
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'apply') {
          JSON.parse(options.input ?? '{}');
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') {
          if (args[1]?.startsWith('sandbox/')) phase = 'Running';
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl, noopLogger);
    const expectedName = manager.ref({
      workspaceId: 'ws_kaiyan__u-1',
      sessionId: 'session-1',
      sandboxScopeId: 'ws_kaiyan__u-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
    }).name;

    const ref = await manager.resumeByName(expectedName);

    expect(ref).toMatchObject({
      name: expectedName,
      workspaceId: 'ws_kaiyan__u-1',
      sessionId: 'session-1',
      sandboxScopeId: 'ws_kaiyan__u-1',
      mountSubPath: 'workspaces/kaiyan/u-1',
    });
    expect(calls.some((args) => args[0] === 'patch' && args[1] === `sandbox/${expectedName}` && String(args[4]).includes('"paused":false'))).toBe(true);
  });

  it('prewarmStaleImagePausedSandboxes: 预热 Paused 旧镜像 sandbox，成功后保持 Running 到 idle pause', async () => {
    const calls: string[][] = [];
    const currentImage = 'registry.example.com/agent-saas/acs-sandbox:new-tag';
    let oldPausedName = '';
    let currentPausedName = '';
    let oldRunningName = '';
    let oldBusyName = '';
    let noImageName = '';
    let oldPhase = 'Paused';
    let appliedSandboxImage: string | undefined;
    const annotationsFor = (workspaceId: string, sessionId: string) => ({
      'agent-saas.kaiyan.net/workspace-id': workspaceId,
      'agent-saas.kaiyan.net/session-id': sessionId,
      'agent-saas.kaiyan.net/mount-subpath': workspaceId,
    });
    const sandboxItem = (name: string, workspaceId: string, sessionId: string, phase: string, image?: string) => ({
      metadata: {
        name,
        annotations: annotationsFor(workspaceId, sessionId),
      },
      ...(image ? { spec: { template: { spec: { containers: [{ name: 'sandbox', image }] } } } } : { spec: { template: { spec: { containers: [] } } } }),
      status: { phase },
    });
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                sandboxItem(oldPausedName, 'ws_old_paused', 'session-old-paused', oldPhase, 'registry.example.com/agent-saas/acs-sandbox:old-tag'),
                sandboxItem(currentPausedName, 'ws_current_paused', 'session-current-paused', 'Paused', currentImage),
                sandboxItem(oldRunningName, 'ws_old_running', 'session-old-running', 'Running', 'registry.example.com/agent-saas/acs-sandbox:old-tag'),
                sandboxItem(oldBusyName, 'ws_old_busy', 'session-old-busy', 'Paused', 'registry.example.com/agent-saas/acs-sandbox:old-tag'),
                sandboxItem(noImageName, 'ws_no_image', 'session-no-image', 'Paused'),
              ],
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        if (args[0] === 'get' && args[1] === `sandbox/${oldPausedName}`) {
          return {
            stdout: JSON.stringify({
              spec: { template: { spec: { containers: [{ name: 'sandbox', image: oldPhase === 'Paused' ? 'registry.example.com/agent-saas/acs-sandbox:old-tag' : currentImage }] } } },
              status: { phase: oldPhase },
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string; spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } } };
          if (manifest.kind === 'Sandbox') {
            appliedSandboxImage = manifest.spec?.template?.spec?.containers?.[0]?.image;
            oldPhase = 'Running';
          }
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') {
          if (args[1] === `sandbox/${oldPausedName}` && String(args[4] ?? '').includes('"paused":true')) oldPhase = 'Paused';
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'delete') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxImage: currentImage,
    }, kubectl, noopLogger);
    oldPausedName = manager.ref({ workspaceId: 'ws_old_paused', sessionId: 'session-old-paused' }).name;
    currentPausedName = manager.ref({ workspaceId: 'ws_current_paused', sessionId: 'session-current-paused' }).name;
    oldRunningName = manager.ref({ workspaceId: 'ws_old_running', sessionId: 'session-old-running' }).name;
    oldBusyName = manager.ref({ workspaceId: 'ws_old_busy', sessionId: 'session-old-busy' }).name;
    noImageName = manager.ref({ workspaceId: 'ws_no_image', sessionId: 'session-no-image' }).name;
    const bootstrapped: string[] = [];

    const result = await manager.prewarmStaleImagePausedSandboxes({
      busySandboxNames: new Set([oldBusyName]),
      bootstrap: async (ref) => { bootstrapped.push(ref.name); },
    });

    expect(result.queued).toEqual([oldPausedName]);
    expect(result.prewarmed).toEqual([oldPausedName]);
    expect(result.skippedBusy).toEqual([oldBusyName]);
    expect(result.skipped).toEqual(expect.arrayContaining([noImageName]));
    expect(bootstrapped).toEqual([oldPausedName]);
    expect(appliedSandboxImage).toBe(currentImage);
    expect(calls.some((args) => args[0] === 'delete')).toBe(false);
    expect(calls.some((args) => args[0] === 'patch' && args[1] === `sandbox/${oldPausedName}` && String(args[4] ?? '').includes('"paused":true'))).toBe(false);
    expect(calls.some((args) => args[0] === 'apply' && args[1] === '-f')).toBe(true);
    expect(oldPhase).toBe('Running');
  });

  it('cleanupSandboxes: as-ws-ci-* 前缀走 sandboxCiTtlMs 短 TTL', async () => {
    const calls: string[][] = [];
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                {
                  // CI sandbox，8h idle 已过 6h 短 TTL → 应该删
                  metadata: {
                    name: 'as-ws-ci-acr-12345-abc',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-26T16:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-26T16:00:00.000Z',
                    },
                  },
                  status: { phase: 'Paused' },
                },
                {
                  // 用户 sandbox 同样 8h idle，普通 TTL 7d 未到 → 不该删
                  metadata: {
                    name: 'as-ws-pantheon-user-workspace-xxx',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-26T16:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-26T16:00:00.000Z',
                    },
                  },
                  status: { phase: 'Paused' },
                },
                {
                  // CI sandbox 4h idle，未过 6h 短 TTL → 不该删
                  metadata: {
                    name: 'as-ws-ci-acs-manual-99999',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-06-26T20:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-06-26T20:00:00.000Z',
                    },
                  },
                  status: { phase: 'Paused' },
                },
              ],
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        if (args[0] === 'delete' || args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxIdlePauseMs: 5 * 60_000,
      sandboxTtlMs: 7 * 24 * 60 * 60_000,
      sandboxCiTtlMs: 6 * 60 * 60_000,
    }, kubectl, noopLogger);

    // now = 2026-06-27 00:00：ci-acr idle 8h（应删）/ 用户 idle 8h（不删）/ ci-manual idle 4h（不删）
    const report = await manager.cleanupSandboxes({ now: new Date('2026-06-27T00:00:00.000Z') });

    expect(report.deleted).toEqual(['as-ws-ci-acr-12345-abc']);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === 'sandbox/as-ws-ci-acr-12345-abc')).toBe(true);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === 'sandbox/as-ws-pantheon-user-workspace-xxx')).toBe(false);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === 'sandbox/as-ws-ci-acs-manual-99999')).toBe(false);
  });

  it('cleanupSandboxes: sandboxCiTtlMs=0 时 CI sandbox 回退到普通 sandboxTtlMs', async () => {
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [{
                metadata: {
                  name: 'as-ws-ci-acr-12345',
                  annotations: {
                    'agent-saas.kaiyan.net/created-at': '2026-06-26T16:00:00.000Z',
                    'agent-saas.kaiyan.net/last-active-at': '2026-06-26T16:00:00.000Z',
                  },
                },
                status: { phase: 'Paused' },
              }],
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxIdlePauseMs: 5 * 60_000,
      sandboxTtlMs: 7 * 24 * 60 * 60_000,
      sandboxCiTtlMs: 0,  // 关闭 CI 短 TTL
    }, kubectl, noopLogger);

    // 8h idle 远小于 7d，不删
    const report = await manager.cleanupSandboxes({ now: new Date('2026-06-27T00:00:00.000Z') });
    expect(report.deleted).toEqual([]);
  });

  it('prewarmStaleImagePausedSandboxes: 没有 sandbox 时返回空报告', async () => {
    const kubectl = {
      async run(): Promise<KubectlResult> {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger);
    const result = await manager.prewarmStaleImagePausedSandboxes();
    expect(result).toEqual({ checked: 0, queued: [], prewarmed: [], adopted: [], skipped: [], skippedBusy: [], failed: [] });
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
    imageCacheEnabled: true,
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 7 * 24 * 60 * 60_000,
    sandboxCiTtlMs: 6 * 60 * 60_000,
    sandboxOrphanGraceMs: 1_800_000,
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
    },
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

// ─── 2026-07-31 冷启动治理批次：already_running 快路径 + ensure 合流 ───

describe('SandboxManager ensure fast path & coalescing', () => {
  const ok = (stdout = ''): KubectlResult => ({ stdout, stderr: '', exitCode: 0, signal: null });

  function runningSandboxJson(config: AcsOrchestratorConfig, input: { workspaceId: string; mountSubPath?: string }, phase = 'Running', paused = false) {
    return JSON.stringify({
      metadata: {
        annotations: {
          'agent-saas.kaiyan.net/workspace-id': input.workspaceId,
          'agent-saas.kaiyan.net/mount-subpath': input.mountSubPath ?? input.workspaceId,
        },
      },
      spec: {
        paused,
        template: { spec: { containers: [{ name: config.sandboxContainerName, image: config.sandboxImage }] } },
      },
      status: { phase },
    });
  }

  function isApplyKind(args: string[], options: { input?: string } | undefined, kind: string): boolean {
    if (args[0] !== 'apply') return false;
    try {
      return (JSON.parse(options?.input ?? '{}') as { kind?: string }).kind === kind;
    } catch {
      return false;
    }
  }

  it('already_running 完整校验后走快路径：跳过 TrafficPolicy reconcile 且 60s 内不重复 touch', async () => {
    const config = baseConfig();
    const input = { workspaceId: 'ws-fast', sessionId: 's-1' };
    let trafficPolicyApplies = 0;
    let touchPatches = 0;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get') return ok(runningSandboxJson(config, input));
        if (isApplyKind(args, options, 'TrafficPolicy')) { trafficPolicyApplies += 1; return ok(); }
        if (args[0] === 'patch') { touchPatches += 1; return ok(); }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(config, kubectl, noopLogger);

    await manager.ensureRunning(input);
    expect(trafficPolicyApplies).toBe(1);
    expect(touchPatches).toBe(1);

    await manager.ensureRunning(input);
    await manager.ensureRunning(input);
    // 快路径：不再 reconcile TrafficPolicy，touch 被 60s 节流
    expect(trafficPolicyApplies).toBe(1);
    expect(touchPatches).toBe(1);
  });

  it('pause 使快路径缓存失效：下一次 ensureRunning 重新完整校验', async () => {
    const config = baseConfig();
    const input = { workspaceId: 'ws-invalidate', sessionId: 's-1' };
    let trafficPolicyApplies = 0;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get') return ok(runningSandboxJson(config, input));
        if (isApplyKind(args, options, 'TrafficPolicy')) { trafficPolicyApplies += 1; return ok(); }
        if (args[0] === 'patch') return ok();
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(config, kubectl, noopLogger);

    const ref = await manager.ensureRunning(input);
    await manager.ensureRunning(input);
    expect(trafficPolicyApplies).toBe(1);

    await manager.patchPaused(ref.name, true);
    await manager.ensureRunning(input);
    expect(trafficPolicyApplies).toBe(2);
  });

  it('Paused 状态不走快路径：即使缓存新鲜也执行 resume', async () => {
    const config = baseConfig();
    const input = { workspaceId: 'ws-resume', sessionId: 's-1' };
    let phase = 'Running';
    let paused = false;
    let unpausePatches = 0;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get') return ok(runningSandboxJson(config, input, phase, paused));
        if (isApplyKind(args, options, 'TrafficPolicy')) return ok();
        if (args[0] === 'patch') {
          const body = JSON.parse(args[args.length - 1] ?? '{}') as { spec?: { paused?: boolean } };
          if (body.spec && body.spec.paused === false) {
            unpausePatches += 1;
            phase = 'Running';
            paused = false;
          }
          return ok();
        }
        if (args[0] === 'get' && args[1] === 'sandbox') return ok(JSON.stringify({ items: [] }));
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager({ ...config, sandboxWaitTimeoutMs: 5_000, maxRunningSandboxes: 0 }, kubectl, noopLogger);

    await manager.ensureRunning(input);
    phase = 'Paused';
    paused = true;
    await manager.ensureRunning(input);
    expect(unpausePatches).toBe(1);
  });

  it('同名并发 ensureRunning 合流：只执行一次创建流程', async () => {
    const config = { ...baseConfig(), sandboxWaitTimeoutMs: 5_000, maxRunningSandboxes: 0 };
    const input = { workspaceId: 'ws-coalesce', sessionId: 's-1' };
    let created = false;
    let sandboxApplies = 0;
    let applyStarted!: () => void;
    const applyGate = new Promise<void>((resolveGate) => { applyStarted = resolveGate; });
    let releaseApply!: () => void;
    const applyBlock = new Promise<void>((resolveBlock) => { releaseApply = resolveBlock; });
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) return ok(JSON.stringify({ items: [] }));
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return ok(runningSandboxJson(config, input));
        }
        if (isApplyKind(args, options, 'Sandbox')) {
          sandboxApplies += 1;
          applyStarted();
          await applyBlock;
          created = true;
          return ok();
        }
        if (args[0] === 'apply') return ok();
        if (args[0] === 'patch') return ok();
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(config, kubectl, noopLogger);

    const first = manager.ensureRunning(input);
    await applyGate;
    const second = manager.ensureRunning(input);
    releaseApply();
    const [ref1, ref2] = await Promise.all([first, second]);
    expect(ref1.name).toBe(ref2.name);
    expect(sandboxApplies).toBe(1);
  });
});

// ─── 2026-07-31 冷启动治理批次 2：broken 判定收窄 + resume 快路径 + Failed fail-fast ───

describe('brokenSandboxStateReason 收窄（recreating 常态化）', () => {
  function pausedStatus(input: { specPaused: boolean; recreating: boolean; imageChanged?: boolean }) {
    return {
      phase: 'Paused',
      raw: {
        spec: { paused: input.specPaused },
        status: {
          phase: 'Paused',
          ...(input.imageChanged
            ? { conditions: [{ type: 'SandboxPaused', status: 'False', reason: 'ImageChanged', message: 'pause is not allowed' }] }
            : {}),
          podInfo: { annotations: input.recreating ? { 'ops.alibabacloud.com/recreating': 'true' } : {} },
        },
      },
    };
  }

  it('正常 pause（spec.paused=true）+ recreating 注记不再判 broken', () => {
    expect(brokenSandboxStateReason(pausedStatus({ specPaused: true, recreating: true }))).toBeUndefined();
  });

  it('spec 要求 Running 但 phase 停在 Paused 仍判 requested_running', () => {
    expect(brokenSandboxStateReason(pausedStatus({ specPaused: false, recreating: true }))).toBe('requested_running');
    expect(brokenSandboxStateReason(pausedStatus({ specPaused: false, recreating: false }))).toBe('requested_running');
  });

  it('ImageChanged 半状态仍判 image_changed（07-06 原始故障场景）', () => {
    expect(brokenSandboxStateReason(pausedStatus({ specPaused: false, recreating: true, imageChanged: true }))).toBe('image_changed');
  });

  it('Failed 终态判定不受影响', () => {
    expect(brokenSandboxStateReason({
      phase: 'Failed',
      raw: { status: { phase: 'Failed', message: 'Pod Not Found' } },
    })).toBe('failed_pod_not_found');
  });
});

describe('resume 快路径与 Failed fail-fast', () => {
  const ok = (stdout = ''): KubectlResult => ({ stdout, stderr: '', exitCode: 0, signal: null });

  it('Paused+recreating 走 resume_paused：patch unpause，不删除不重建', async () => {
    const config = { ...baseConfig(), sandboxWaitTimeoutMs: 5_000, maxRunningSandboxes: 0 };
    const input = { workspaceId: 'ws-resume2', sessionId: 's-1' };
    let phase = 'Paused';
    let specPaused = true;
    let deletes = 0;
    let sandboxApplies = 0;
    let unpausePatches = 0;
    const sandboxJson = () => JSON.stringify({
      metadata: { annotations: { 'agent-saas.kaiyan.net/mount-subpath': input.workspaceId } },
      spec: {
        paused: specPaused,
        template: { spec: { containers: [{ name: config.sandboxContainerName, image: config.sandboxImage }] } },
      },
      status: {
        phase,
        podInfo: { annotations: { 'ops.alibabacloud.com/recreating': 'true' } },
      },
    });
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) return ok(JSON.stringify({ items: [] }));
        if (args[0] === 'get') return ok(sandboxJson());
        if (args[0] === 'delete') { deletes += 1; return ok(); }
        if (args[0] === 'apply') {
          const kind = (JSON.parse(options.input ?? '{}') as { kind?: string }).kind;
          if (kind === 'Sandbox') sandboxApplies += 1;
          return ok();
        }
        if (args[0] === 'patch') {
          const body = JSON.parse(args[args.length - 1] ?? '{}') as { spec?: { paused?: boolean } };
          if (body.spec && body.spec.paused === false) {
            unpausePatches += 1;
            phase = 'Running';
            specPaused = false;
          }
          return ok();
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(config, kubectl, noopLogger);

    await manager.ensureRunning(input);
    expect(unpausePatches).toBe(1);
    expect(deletes).toBe(0);
    expect(sandboxApplies).toBe(0);
  });

  it('等待 Running 期间遇到 Failed 终态立即失败，不空转到超时', async () => {
    const config = { ...baseConfig(), sandboxWaitTimeoutMs: 60_000, maxRunningSandboxes: 0 };
    const input = { workspaceId: 'ws-failfast', sessionId: 's-1' };
    let created = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) return ok(JSON.stringify({ items: [] }));
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return ok(JSON.stringify({ status: { phase: 'Failed', message: 'image pull backoff' } }));
        }
        if (args[0] === 'apply') { created = true; return ok(); }
        if (args[0] === 'patch') return ok();
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(config, kubectl, noopLogger);

    const startedAt = Date.now();
    await expect(manager.ensureRunning(input)).rejects.toThrow(/Failed 终态/);
    // 首轮 get 即 Failed → 秒级失败，绝不等满 60s
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('ImageCache 注解（2026-07-31 方案3-P0）', () => {
  const ok = (stdout = ''): KubectlResult => ({ stdout, stderr: '', exitCode: 0, signal: null });

  async function applyAndGetPodAnnotations(imageCacheEnabled: boolean) {
    let podTemplateAnnotations: Record<string, string> | undefined;
    let created = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) return ok(JSON.stringify({ items: [] }));
        if (args[0] === 'get') {
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return ok(JSON.stringify({ status: { phase: 'Running' } }));
        }
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as {
            kind?: string;
            spec?: { template?: { metadata?: { annotations?: Record<string, string> } } };
          };
          if (manifest.kind === 'Sandbox') {
            podTemplateAnnotations = manifest.spec?.template?.metadata?.annotations;
            created = true;
          }
          return ok();
        }
        if (args[0] === 'patch') return ok();
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(
      { ...baseConfig(), imageCacheEnabled, sandboxWaitTimeoutMs: 5_000, maxRunningSandboxes: 0 },
      kubectl,
      noopLogger,
    );
    await manager.ensureRunning({ workspaceId: `ws-imc-${imageCacheEnabled}`, sessionId: 's-1' });
    return podTemplateAnnotations;
  }

  it('默认开启时 pod template 带 enable-image-cache 注解', async () => {
    const annotations = await applyAndGetPodAnnotations(true);
    expect(annotations?.['image.alibabacloud.com/enable-image-cache']).toBe('true');
  });

  it('关闭时不带该注解', async () => {
    const annotations = await applyAndGetPodAnnotations(false);
    expect(annotations?.['image.alibabacloud.com/enable-image-cache']).toBeUndefined();
  });
});
