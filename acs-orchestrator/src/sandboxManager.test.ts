import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager, brokenSandboxStateReason } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';
import { isRawSandboxDelete, mockCurrentSandboxStatusReads } from './sandboxManagerLifecycleTestFixtures.js';

describe('SandboxManager egress injection', () => {
  async function applyWithEgress(egress: AcsOrchestratorConfig['egress']) {
    const applies: Array<Record<string, unknown>> = [];
    let created = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
    expect(byName.https_proxy).toBe('http://172.16.177.77:7890'); expect(byName.NODE_USE_ENV_PROXY).toBe('1');
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
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
                metadata: { uid: 'uid-broken', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: {
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

  it('defers a busy Running image upgrade, then rebuilds on the next idle ensure', async () => {
    const calls: string[][] = [];
    let state: 'old' | 'missing' | 'running' = 'old';
    let sandboxApplyCount = 0;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
          if (state === 'missing') return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          const image = state === 'old'
            ? 'registry.example.com/agent-saas/acs-sandbox:old'
            : 'registry.example.com/agent-saas/acs-sandbox:test';
          return {
            stdout: JSON.stringify({
              status: { phase: 'Running' },
              spec: { template: { spec: { containers: [{ name: 'sandbox', image }] } } },
              metadata: { uid: 'uid-image', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: { 'agent-saas.kaiyan.net/mount-subpath': 'workspaces/kaiyan/u-1' } },
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'delete') {
          state = 'missing';
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string };
          if (manifest.kind === 'Sandbox') {
            sandboxApplyCount += 1;
            state = 'running';
          }
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const activeRegistry = new ActiveSandboxRegistry();
    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger, activeRegistry);
    const input = {
      workspaceId: 'ws_kaiyan__test',
      sessionId: 'session-456',
      mountSubPath: 'workspaces/kaiyan/u-1',
    };
    const busyName = manager.ref(input).name;
    const currentKey = 'current-invocation';
    const releaseCurrent = activeRegistry.acquire(busyName, currentKey);
    const releaseOther = activeRegistry.acquire(busyName, 'other-invocation');

    try {
      await expect(manager.ensureRunning(input, {
        busySandboxNames: new Set([busyName]),
        activeKey: currentKey,
      })).resolves.toMatchObject({ name: busyName });
      expect(calls.some((args) => args[0] === 'delete')).toBe(false);
      expect(sandboxApplyCount).toBe(0);

      releaseOther();
      await expect(manager.ensureRunning(input, {
        // executor 的集合仍包含当前 invocation；activeKey 必须让它不阻塞空闲升级。
        busySandboxNames: new Set([busyName]),
        activeKey: currentKey,
      })).resolves.toMatchObject({ name: busyName });
      expect(calls.some((args) => args[0] === 'delete')).toBe(true);
      expect(sandboxApplyCount).toBe(1);
    } finally {
      releaseOther();
      releaseCurrent();
    }
  });

  it('recreates a broken Paused Sandbox instead of waiting for resume forever', async () => {
    const calls: string[][] = [];
    const currentImage = 'registry.example.com/agent-saas/acs-sandbox:test';
    let state: 'broken' | 'missing' | 'running' = 'broken';
    let appliedSandbox = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
          if (state === 'missing') return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          if (state === 'broken') {
            return {
              stdout: JSON.stringify({
                metadata: { uid: 'uid-broken', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: {
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
              metadata: { uid: 'uid-running', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: {
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
          if (args[1]?.startsWith('sandbox/') || args[1]?.startsWith('--raw=')) state = 'missing';
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

    expect(calls.some((args) => args[0] === 'delete' && (args[1] === `sandbox/${ref.name}` || args[1]?.includes(`/sandboxes/${ref.name}`)))).toBe(true);
    expect(appliedSandbox).toBe(true);
    expect(calls.some((args) => args[0] === 'patch' && args[1] === `sandbox/${ref.name}` && String(args[4] ?? '').includes('"paused":false'))).toBe(false);
  });

  it('recreates a Failed Sandbox with missing pod instead of waiting until provision timeout', async () => {
    const calls: string[][] = [];
    const currentImage = 'registry.example.com/agent-saas/acs-sandbox:test';
    let state: 'failed' | 'missing' | 'running' = 'failed';
    let appliedSandbox = false;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
          if (state === 'missing') return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          if (state === 'failed') {
            return {
              stdout: JSON.stringify({
                metadata: { uid: 'uid-broken', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: {
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
              metadata: { uid: 'uid-running', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: {
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
          if (args[1]?.startsWith('sandbox/') || args[1]?.startsWith('--raw=')) state = 'missing';
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

    expect(calls.some((args) => args[0] === 'delete' && (args[1] === `sandbox/${ref.name}` || args[1]?.includes(`/sandboxes/${ref.name}`)))).toBe(true);
    expect(appliedSandbox).toBe(true);
  });

  it('rejects creating a new Sandbox when allocated quota is exhausted', async () => {
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
      .rejects.toThrow(/capacity exhausted/);
  });

  it('evicts the oldest still-Paused Sandbox before enforcing allocated quota', async () => {
    const calls: string[][] = [];
    let created = false, idleDeleted = false;
    let applied: Record<string, unknown> | undefined;
    const idleSandbox = {
      metadata: { name: 'as-idle', uid: 'uid-as-idle', resourceVersion: '1',
        finalizers: ['agent-saas.kaiyan.net/network-cleanup'], annotations: {
        'agent-saas.kaiyan.net/created-at': '2026-06-27T00:00:00.000Z',
        'agent-saas.kaiyan.net/last-active-at': '2026-06-27T00:00:00.000Z',
      } }, status: { phase: 'Paused' },
    };
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args[1] === 'sandbox' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: idleDeleted ? [] : [idleSandbox],
            }),
            stderr: '',
            exitCode: 0,
            signal: null,
          };
        }
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
          if (args[1] === 'sandbox/as-idle') return idleDeleted ? { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null } : { stdout: JSON.stringify(idleSandbox), stderr: '', exitCode: 0, signal: null };
          if (!created) return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
          return { stdout: JSON.stringify({ status: { phase: 'Running' } }), stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'delete') { if (isRawSandboxDelete(args, 'as-idle')) idleDeleted = true;
          return { stdout: '', stderr: '', exitCode: 0, signal: null }; }
        if (args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
    }, kubectl, noopLogger); mockCurrentSandboxStatusReads(manager);
    await manager.ensureRunning({ workspaceId: 'ws_kaiyan__test', sessionId: 'session-123' });

    expect(applied).toBeTruthy();
    expect(calls.some((args) => isRawSandboxDelete(args, 'as-idle'))).toBe(true);
  });

  it('never force-pauses a Running Sandbox to make room', async () => {
    const calls: string[][] = [];
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
                  status: { phase: 'Running' },
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
          if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
          return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
        }
        if (args[0] === 'patch' || args[0] === 'delete' || args[0] === 'apply') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      maxRunningSandboxes: 2,
      sandboxIdlePauseMs: 60 * 60_000,
      sandboxTtlMs: 0,
    }, kubectl, noopLogger);

    await expect(manager.ensureRunning(
      { workspaceId: 'ws_kaiyan__test', sessionId: 'session-123' },
      { busySandboxNames: new Set(['as-busy']) },
    )).rejects.toThrow(/capacity exhausted/);

    expect(calls.some((args) => args[0] === 'patch' && args[1] === 'sandbox/as-old')).toBe(false);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === 'sandbox/as-old')).toBe(false);
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
        if ((args[0] === 'get' && (args.includes('--ignore-not-found=true') || args[2] === '-o')) || args[0] === 'patch' || args[0] === 'delete') {
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxIdlePauseMs: 5 * 60_000,
      sandboxTtlMs: 7 * 24 * 60 * 60_000,
    }, kubectl, noopLogger); mockCurrentSandboxStatusReads(manager);
    const report = await manager.cleanupSandboxes({
      now: new Date('2026-06-27T00:20:00.000Z'),
      busySandboxNames: new Set(['as-busy']),
    });

    expect(report.paused).toEqual(['as-idle']);
    expect(report.deleted).toEqual(['as-expired']);
    expect(report.skippedBusy).toEqual(['as-busy']);
    expect(calls.some((args) => args[0] === 'patch' && args[1] === 'sandbox/as-idle')).toBe(true);
    expect(calls.some((args) => isRawSandboxDelete(args, 'as-expired'))).toBe(true);
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

  it('listSandboxInventory: derives remaining time from lifecycle deadline, not global TTL', async () => {
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
    const result = await manager.listSandboxInventory({ now: new Date('2026-07-06T00:30:00.000Z') });

    expect(result).toMatchObject([{
      name: 'as-broken',
      workspaceId: 'ws_kaiyan__u-1',
      phase: 'Paused',
      brokenReason: 'image_changed',
      busy: false,
      imageStale: true,
      idleMs: 10 * 60_000,
      effectiveTtlMs: 30 * 60_000,
      ttlRemainingMs: 20 * 60_000,
      lifecycleDeadlineAt: '2026-07-06T00:50:00.000Z',
    }]);
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

  it('prewarmStaleImagePausedSandboxes: stale Paused 直接删除退役，不原地换镜像（07-22/08-01 事故修复）', async () => {
    const calls: string[][] = [];
    const currentImage = 'registry.example.com/agent-saas/acs-sandbox:new-tag';
    let oldPausedName = '';
    let currentPausedName = '';
    let oldRunningName = '';
    let oldBusyName = '';
    let noImageName = '';
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
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                sandboxItem(oldPausedName, 'ws_old_paused', 'session-old-paused', 'Paused', 'registry.example.com/agent-saas/acs-sandbox:old-tag'),
                sandboxItem(currentPausedName, 'ws_current_paused', 'session-current-paused', 'Paused', currentImage),
                sandboxItem(oldRunningName, 'ws_old_running', 'session-old-running', 'Running', 'registry.example.com/agent-saas/acs-sandbox:old-tag'),
                sandboxItem(oldBusyName, 'ws_old_busy', 'session-old-busy', 'Paused', 'registry.example.com/agent-saas/acs-sandbox:old-tag'),
                sandboxItem(noImageName, 'ws_no_image', 'session-no-image', 'Paused'),
              ],
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        if (args[0] === 'get' && args[1] === `sandbox/${oldPausedName}` && !args.includes('--ignore-not-found=true')) {
          return {
            stdout: JSON.stringify({
              metadata: { uid: 'uid-old-paused', resourceVersion: '1', finalizers: ['agent-saas.kaiyan.net/network-cleanup'] },
              spec: { template: { spec: { containers: [{ name: 'sandbox', image: 'registry.example.com/agent-saas/acs-sandbox:old-tag' }] } } },
              status: { phase: 'Paused' },
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        if ((args[0] === 'get' && args.includes('--ignore-not-found=true')) || args[0] === 'delete' || args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
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

    const result = await manager.prewarmStaleImagePausedSandboxes({
      busySandboxNames: new Set([oldBusyName]),
    });

    expect(result.queued).toEqual([oldPausedName]);
    expect(result.retired).toEqual([oldPausedName]);
    expect(result.failed).toEqual([]);
    expect(result.skippedBusy).toEqual([oldBusyName]);
    expect(result.skipped).toEqual(expect.arrayContaining([noImageName]));
    // stale Paused 只允许 delete：绝不能 applySandbox 原地换镜像（会留 ImageChanged
    // 半状态或让后续 pause 卡死），也绝不能 patch paused。
    expect(calls.some((args) => isRawSandboxDelete(args, oldPausedName))).toBe(true);
    expect(calls.some((args) => args[0] === 'apply')).toBe(false);
    expect(calls.some((args) => args[0] === 'patch' && String(args[4] ?? '').includes('"paused"'))).toBe(false);
    // 镜像已是当前版的 Paused 与 Running 中的旧镜像 sandbox 都不许删。
    expect(calls.some((args) => args[0] === 'delete' && args[1] === `sandbox/${currentPausedName}`)).toBe(false);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === `sandbox/${oldRunningName}`)).toBe(false);
    expect(calls.some((args) => args[0] === 'delete' && args[1] === `sandbox/${oldBusyName}`)).toBe(false);
  });

  it('cleanupSandboxes: broken Paused（假暂停）超过宽限期被自愈回收，宽限内与 busy 不动', async () => {
    const calls: string[][] = [];
    const now = new Date('2026-08-01T12:00:00.000Z');
    const brokenItem = (name: string, opts: { specPaused?: boolean; condChangedAt: string; lastActiveAt: string }) => ({
      metadata: {
        name,
        annotations: {
          'agent-saas.kaiyan.net/workspace-id': `ws_${name}`,
          'agent-saas.kaiyan.net/session-id': `session-${name}`,
          'agent-saas.kaiyan.net/created-at': '2026-08-01T00:00:00.000Z',
          'agent-saas.kaiyan.net/last-active-at': opts.lastActiveAt,
        },
      },
      spec: {
        ...(opts.specPaused === undefined ? {} : { paused: opts.specPaused }),
        template: { spec: { containers: [{ name: 'sandbox', image: 'registry.example.com/agent-saas/acs-sandbox:new-tag' }] } },
      },
      status: {
        phase: 'Paused',
        conditions: [{ type: 'SandboxPaused', status: 'False', reason: 'ImageChanged', lastTransitionTime: opts.condChangedAt }],
      },
    });
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                // 07-22 型半状态：spec.paused=false + ImageChanged/False，broken 已 2h → 回收
                brokenItem('stale-half', { specPaused: false, condChangedAt: '2026-08-01T10:00:00.000Z', lastActiveAt: '2026-08-01T09:00:00.000Z' }),
                // 08-01 型 pause 卡死：spec.paused=true + ImageChanged/False，broken 已 1h → 回收
                brokenItem('pause-stuck', { specPaused: true, condChangedAt: '2026-08-01T11:00:00.000Z', lastActiveAt: '2026-08-01T09:00:00.000Z' }),
                // condition 2 分钟前刚翻转（宽限 5min 内）→ 不动（可能是正常 pause 过渡态）
                brokenItem('fresh-transition', { specPaused: true, condChangedAt: '2026-08-01T11:58:00.000Z', lastActiveAt: '2026-08-01T09:00:00.000Z' }),
                // broken 但 busy → 不动
                brokenItem('busy-broken', { specPaused: false, condChangedAt: '2026-08-01T10:00:00.000Z', lastActiveAt: '2026-08-01T09:00:00.000Z' }),
                // 正常真暂停：SandboxPaused=True → 不动
                {
                  metadata: {
                    name: 'healthy-paused',
                    annotations: {
                      'agent-saas.kaiyan.net/created-at': '2026-08-01T00:00:00.000Z',
                      'agent-saas.kaiyan.net/last-active-at': '2026-08-01T09:00:00.000Z',
                    },
                  },
                  spec: { paused: true, template: { spec: { containers: [{ name: 'sandbox', image: 'registry.example.com/agent-saas/acs-sandbox:new-tag' }] } } },
                  status: {
                    phase: 'Paused',
                    conditions: [{ type: 'SandboxPaused', status: 'True', reason: 'DeletePod', lastTransitionTime: '2026-08-01T10:00:00.000Z' }],
                  },
                },
              ],
            }),
            stderr: '', exitCode: 0, signal: null,
          };
        }
        if ((args[0] === 'get' && (args.includes('--ignore-not-found=true') || args[2] === '-o')) || args[0] === 'delete') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxImage: 'registry.example.com/agent-saas/acs-sandbox:new-tag',
      sandboxBrokenRecycleGraceMs: 300_000,
    }, kubectl, noopLogger); mockCurrentSandboxStatusReads(manager);
    const report = await manager.cleanupSandboxes({ busySandboxNames: new Set(['busy-broken']), now });

    expect(report.brokenRecycled.sort()).toEqual(['pause-stuck', 'stale-half']);
    expect(report.skippedBusy).toEqual(['busy-broken']);
    expect(report.deleted).toEqual([]);
    expect(calls.some((args) => isRawSandboxDelete(args, 'stale-half'))).toBe(true); expect(calls.some((args) => isRawSandboxDelete(args, 'pause-stuck'))).toBe(true);
    expect(calls.some((args) => isRawSandboxDelete(args, 'fresh-transition'))).toBe(false); expect(calls.some((args) => isRawSandboxDelete(args, 'busy-broken'))).toBe(false);
    expect(calls.some((args) => isRawSandboxDelete(args, 'healthy-paused'))).toBe(false);
  });

  it('cleanupSandboxes: CI 命名前缀与用户 Sandbox 使用相同 TTL', async () => {
    const calls: string[][] = [];
    const kubectl = {
      async run(args: string[]): Promise<KubectlResult> {
        calls.push(args);
        if (args[0] === 'get' && args.includes('-l')) {
          return {
            stdout: JSON.stringify({
              items: [
                {
                  // CI 部署冒烟 Sandbox，8h idle 已过统一 6h TTL → 应该删
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
                  // 用户 Sandbox 同样 8h idle，也已过统一 6h TTL → 应该删
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
                  // CI 部署冒烟 Sandbox 4h idle，未过统一 6h TTL → 不该删
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
        if ((args[0] === 'get' && (args.includes('--ignore-not-found=true') || args[2] === '-o')) || args[0] === 'delete' || args[0] === 'patch') return { stdout: '', stderr: '', exitCode: 0, signal: null };
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;

    const manager = new SandboxManager({
      ...baseConfig(),
      sandboxIdlePauseMs: 5 * 60_000,
      sandboxTtlMs: 6 * 60 * 60_000,
    }, kubectl, noopLogger);
    mockCurrentSandboxStatusReads(manager);

    // now = 2026-06-27 00:00：两个 8h idle Sandbox 都应删除，4h idle 的不删除。
    const report = await manager.cleanupSandboxes({ now: new Date('2026-06-27T00:00:00.000Z') });

    expect(report.deleted.sort()).toEqual([
      'as-ws-ci-acr-12345-abc',
      'as-ws-pantheon-user-workspace-xxx',
    ]);
    expect(calls.some((args) => isRawSandboxDelete(args, 'as-ws-ci-acr-12345-abc'))).toBe(true);
    expect(calls.some((args) => isRawSandboxDelete(args, 'as-ws-pantheon-user-workspace-xxx'))).toBe(true);
    expect(calls.some((args) => isRawSandboxDelete(args, 'as-ws-ci-acs-manual-99999'))).toBe(false);
  });

  it('prewarmStaleImagePausedSandboxes: 没有 sandbox 时返回空报告', async () => {
    const kubectl = {
      async run(): Promise<KubectlResult> {
        return { stdout: JSON.stringify({ items: [] }), stderr: '', exitCode: 0, signal: null };
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger);
    const result = await manager.prewarmStaleImagePausedSandboxes();
    expect(result).toEqual({ checked: 0, queued: [], retired: [], adopted: [], skipped: [], skippedBusy: [], failed: [] });
  });
});

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
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
        if (args[0] === 'get') { if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '', exitCode: 0, signal: null };
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
