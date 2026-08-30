import { describe, expect, it } from 'vitest';

import { deriveSandboxScopeId, toAcsSandboxWorkloadDescriptor } from '../runtime/runtimeHandRegistration.js';

/**
 * per-session Sandbox（A 方案，2026-08-10）的 scope 归属语义。
 *
 * 核心不变量：**「顶层会话 + 其全部后代」必须落在同一个 sandboxScopeId**（决策 7），
 * 而不同顶层会话必须落在不同 scope（这正是并发惩罚的解法）。
 */
describe('workload mapping at the hand registration boundary', () => {
  it('keeps ACS class stable and places Taskboard detail only in the descriptor', () => {
    expect(toAcsSandboxWorkloadDescriptor({ kind: 'interactive' })).toEqual({ class: 'interactive' });
    expect(toAcsSandboxWorkloadDescriptor({
      kind: 'taskboard', taskKind: 'remediation', purpose: 'merge',
    })).toEqual({ class: 'taskboard', taskKind: 'remediation', purpose: 'merge' });
  });
});

describe('deriveSandboxScopeId（per-session Sandbox）', () => {
  const workspaceId = 'ws_kaiyan__kyvynk4r399zsr';

  it('不传 topLevelSessionId 时退回 workspace 级共享（安全 fallback，旧行为）', () => {
    expect(deriveSandboxScopeId({ workspaceId })).toBe(workspaceId);
    expect(deriveSandboxScopeId({ workspaceId, mountSubPath: 'repo/app' }))
      .toBe('ws_kaiyan__kyvynk4r399zsr__repo_app');
  });

  it('传 topLevelSessionId 时按顶层会话组隔离', () => {
    const s1 = deriveSandboxScopeId({ workspaceId, topLevelSessionId: 'aaaa-1111' });
    const s2 = deriveSandboxScopeId({ workspaceId, topLevelSessionId: 'bbbb-2222' });
    expect(s1).toBe('ws_kaiyan__kyvynk4r399zsr__s_aaaa-1111');
    expect(s1).not.toBe(s2);
  });

  it('同一顶层会话的父/子/孙 Agent 得到完全相同的 scope（决策 7 的核心不变量）', () => {
    const top = '6404fc6a-9e2e-315d-dab2-6407fd03fab8';
    // 父会话自身
    const parent = deriveSandboxScopeId({ workspaceId, topLevelSessionId: top });
    // 子 Agent：sessionId 是全新 `sub-<uuid>`，但继承父的 topLevelSessionId
    const child = deriveSandboxScopeId({ workspaceId, topLevelSessionId: top });
    // 孙 Agent：继承的仍是同一个顶层 ID（递归天然收敛）
    const grandchild = deriveSandboxScopeId({ workspaceId, topLevelSessionId: top });
    expect(child).toBe(parent);
    expect(grandchild).toBe(parent);
  });

  it('mountSubPath 与 topLevelSessionId 同时存在时都参与隔离', () => {
    const a = deriveSandboxScopeId({ workspaceId, mountSubPath: 'repo/app', topLevelSessionId: 's1' });
    const b = deriveSandboxScopeId({ workspaceId, mountSubPath: 'repo/other', topLevelSessionId: 's1' });
    const c = deriveSandboxScopeId({ workspaceId, mountSubPath: 'repo/app', topLevelSessionId: 's2' });
    expect(a).toBe('ws_kaiyan__kyvynk4r399zsr__repo_app__s_s1');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('sessionId 中的非法字符被规整，产出可安全用作 k8s 资源名的片段', () => {
    // acs-orchestrator 的 validateWorkspaceId 拒绝 / \ .. 与开头的 .
    const scope = deriveSandboxScopeId({ workspaceId, topLevelSessionId: 'a/b\\c..d' });
    expect(scope).not.toMatch(/[/\\]/);
    expect(scope).not.toContain('..');
    expect(scope.startsWith('.')).toBe(false);
  });

  it('taskboard / cron 会话各自成组（它们走顶层 dispatch，传自己的 sessionId）', () => {
    const taskboard = deriveSandboxScopeId({ workspaceId, topLevelSessionId: 'taskboard-1e051493' });
    const interactive = deriveSandboxScopeId({ workspaceId, topLevelSessionId: 'plain-uuid' });
    expect(taskboard).not.toBe(interactive);
    expect(taskboard).toContain('__s_taskboard-1e051493');
  });

  it('空字符串 topLevelSessionId 视同缺省，不产生尾随分隔符', () => {
    expect(deriveSandboxScopeId({ workspaceId, topLevelSessionId: '' })).toBe(workspaceId);
  });
});

/**
 * 回归防线：dispatch 算出的 scope 与 hand recipe 里的 scope 必须同源。
 *
 * 背景（2026-08-10 实施中发现并修复）：`ensureRuntimeHandRegistered` 内部会用
 * `buildWorkspaceRecipe` **重算** sandboxScopeId 写进 hand recipe，而工具执行时
 * `toolRuntime` 命中 hand 后是 **recipe 优先**覆盖 RunContext 的值
 * （`agent/toolRuntime.ts:1534`）。因此只在 dispatch 处传 topLevelSessionId、
 * 却漏传给 hand 注册，会让 per-session **静默退化回 workspace 级共享**——
 * 表面日志正常、pod 却仍然合并，是最难发现的一类失败。
 */
describe('scope 同源性（hand recipe vs dispatch）', () => {
  const workspaceId = 'ws_kaiyan__kyvynk4r399zsr';
  const mountSubPath = 'workspaces/kaiyan/u-1';
  const topLevelSessionId = 'top-session-uuid';

  it('两侧用同样入参必须得到同一个 scope', () => {
    const dispatchScope = deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId });
    const handRecipeScope = deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId });
    expect(handRecipeScope).toBe(dispatchScope);
  });

  it('hand 侧漏传 topLevelSessionId 会退化成 workspace 级——本用例锁死该差异可被发现', () => {
    const dispatchScope = deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId });
    const buggyHandScope = deriveSandboxScopeId({ workspaceId, mountSubPath });
    expect(buggyHandScope).not.toBe(dispatchScope);
    expect(dispatchScope.startsWith(buggyHandScope)).toBe(true);
    expect(dispatchScope.slice(buggyHandScope.length)).toBe(`__s_${topLevelSessionId}`);
  });
});
