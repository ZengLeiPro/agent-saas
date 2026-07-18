import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContainerExecutionProvider } from '../agent/containerExecutionProvider.js';
import { WORKSPACE_HAND_TOOLS } from '../agent/toolRuntime.js';
import type { WorkspaceRef } from '../agent/toolRuntime.js';

// 这些用例只覆盖「不依赖 Docker daemon / 镜像」的纯逻辑与执行前守卫：
//   1) networkPolicyStatus / listInternalTools（纯派生，无子进程）
//   2) workspace 越界路径守卫（在 spawn docker 之前同步抛错）
//   3) docker 可执行文件不存在时 classifyDockerError 的 spawnError 分支
// 真正需要容器运行（读写/shell/超时/输出上限）的路径由 containerExecutionProvider.test.ts
// 在 Docker 可用时覆盖；此处不重复，也不伪造。

function workspace(root: string): WorkspaceRef {
  return {
    root,
    userId: 'u-1',
    username: 'alice',
    sessionId: 'session-1',
    executionTarget: 'server-container',
  };
}

describe('ContainerExecutionProvider 纯逻辑与执行前守卫（无需 Docker）', () => {
  const dirs = new Set<string>();
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.clear();
  });

  it('listInternalTools 返回 workspace hand 工具清单', () => {
    const provider = new ContainerExecutionProvider();
    expect(provider.listInternalTools()).toBe(WORKSPACE_HAND_TOOLS);
    expect(provider.listInternalTools().length).toBeGreaterThan(0);
  });

  it('默认 --network none 时 networkPolicyStatus 报告 isolated 且 enforced', () => {
    // 缺省 networkPolicy=isolated + network=none → 隔离生效
    const provider = new ContainerExecutionProvider();
    const status = provider.networkPolicyStatus();
    expect(status.effectivePolicy.mode).toBe('isolated');
    expect(status.effectivePolicy.enforcement).toBe('enforced');
    expect(status.effectivePolicy.publicEgressReachable).toBe(false);
    expect(status.effectivePolicy.privateEgressBlocked).toBe(true);
  });

  it('非隔离策略 + 显式 network 非 none 时 networkPolicyStatus 报告 enforcement=unknown（需宿主防火墙确认）', () => {
    // networkPolicy 非 isolated 才允许 resolveDockerNetworkName 保留显式 network；
    // 此时 dockerNetworkPolicyStatus 走"unknown"分支（隔离与否要靠宿主防火墙探测确认）。
    const provider = new ContainerExecutionProvider({
      networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      network: 'bridge',
    });
    const status = provider.networkPolicyStatus();
    expect(status.effectivePolicy.mode).toBe('public-egress');
    expect(status.effectivePolicy.enforcement).toBe('unknown');
    expect(status.effectivePolicy.publicEgressReachable).toBe('unknown');
  });

  it('Read 越界路径（../ 逃逸）在 spawn docker 之前被拦下，返回 error envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-guard-'));
    dirs.add(root);
    // dockerPath 指向不存在的二进制：若守卫失效误入 spawn，也不会真正跑 Docker。
    const provider = new ContainerExecutionProvider({ dockerPath: '/nonexistent/docker-binary' });

    const resp = await provider.execute({
      toolName: 'Read',
      input: { path: '../../etc/passwd' },
      context: { workspace: workspace(root) },
    });

    expect(resp.status).toBe('error');
    expect(resp.status === 'error' ? resp.error : '').toContain('outside workspace');
    // 越界守卫先于 docker → audit 应为空（没走到 runDocker 的 audit.push）
    expect(resp.audit).toEqual([]);
  });

  it('绝对路径逃逸（指向 workspace 外）同样被路径守卫拦下', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-guard-abs-'));
    const outside = await mkdtemp(join(tmpdir(), 'container-outside-'));
    dirs.add(root);
    dirs.add(outside);
    const provider = new ContainerExecutionProvider({ dockerPath: '/nonexistent/docker-binary' });

    const resp = await provider.execute({
      toolName: 'Edit',
      input: { file_path: join(outside, 'secret.txt'), old_string: 'a', new_string: 'b' },
      context: { workspace: workspace(root) },
    });

    expect(resp.status).toBe('error');
    expect(resp.status === 'error' ? resp.error : '').toContain('outside workspace');
  });

  it('未知工具名返回明确的 error envelope（不 spawn docker）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'container-unknown-'));
    dirs.add(root);
    const provider = new ContainerExecutionProvider({ dockerPath: '/nonexistent/docker-binary' });

    const resp = await provider.execute({
      toolName: 'NoSuchTool',
      input: {},
      context: { workspace: workspace(root) },
    });

    expect(resp.status).toBe('error');
    expect(resp.status === 'error' ? resp.error : '').toContain('unknown tool NoSuchTool');
  });

  it('docker 可执行文件缺失时 Shell 走 classifyDockerError 的 spawnError 分支，报"failed to start"', async () => {
    // 合法 workspace 内路径 → 通过路径守卫 → 进入 runDocker → spawn 一个不存在的
    // 二进制 → child 'error' 事件 → classifyDockerError 返回 spawnError 文案。
    const root = await mkdtemp(join(tmpdir(), 'container-spawn-fail-'));
    dirs.add(root);
    const provider = new ContainerExecutionProvider({
      dockerPath: '/definitely/not/a/real/docker',
      defaultTimeoutMs: 5_000,
    });

    const resp = await provider.execute({
      toolName: 'Shell',
      input: { command: 'echo hi', timeoutMs: 5_000 },
      context: { workspace: workspace(root) },
    });

    expect(resp.status).toBe('error');
    expect(resp.status === 'error' ? resp.error : '').toContain('failed to start');
  });
});
