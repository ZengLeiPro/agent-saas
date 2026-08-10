import { describe, expect, it } from 'vitest';

import { deriveSandboxScopeId } from '../runtime/runtimeHandRegistration.js';

/**
 * per-session Sandbox（A 方案，2026-08-10）的 scope 归属语义。
 *
 * 核心不变量：**「顶层会话 + 其全部后代」必须落在同一个 sandboxScopeId**（决策 7），
 * 而不同顶层会话必须落在不同 scope（这正是并发惩罚的解法）。
 */
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
