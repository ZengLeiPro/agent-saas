import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { loadAndRenderPrompt, loadPrompt } from '../runtime/promptRenderer.js';

const SHARED = resolve(process.cwd(), '../workspace-shared');

describe('prompt smoke', () => {
  it('renders dynamic-shared.md with COMPANY_INFO and zero variables left', () => {
    const out = loadAndRenderPrompt(SHARED, 'dynamic-shared', {
      COMPANY_INFO: '【公司信息】',
    });
    expect(out).toContain('【公司信息】');
    expect(out).toContain('# 公司事实基础');
    expect(out).not.toContain('{{');
  });

  it('renders dynamic-personal.md with persona and IF_NOT_ADMIN block', () => {
    const out = loadAndRenderPrompt(SHARED, 'dynamic-personal', {
      CURRENT_USER: '测试用户',
      AGENT_NAME: '测试体',
      PERSONA: '简洁',
      USER_CWD: '/tmp/x',
      IF_PERSONA: true,
      IF_NO_PERSONA: false,
      IF_NOT_ADMIN: true,
    });
    expect(out).toContain('测试用户');
    expect(out).toContain('「测试体」');
    expect(out).toContain('把你的名字定为');
    expect(out).not.toContain('尚未定义你的个性化人格');
    expect(out).toContain('系统级硬约束');
    expect(out).not.toContain('{{');
  });

  it('renders default identity when persona is absent', () => {
    const out = loadAndRenderPrompt(SHARED, 'dynamic-personal', {
      CURRENT_USER: '测试用户',
      AGENT_NAME: '开开',
      PERSONA: '',
      USER_CWD: '/x',
      IF_PERSONA: false,
      IF_NO_PERSONA: true,
      IF_NOT_ADMIN: true,
    });
    expect(out).toContain('「开开」');
    expect(out).toContain('尚未定义你的个性化人格');
    // 默认态不得虚构「用户起名 / 情感纽带」叙事
    expect(out).not.toContain('把你的名字定为');
    expect(out).not.toContain('情感纽带');
    expect(out).not.toContain('{{');
  });

  it('strips IF_NOT_ADMIN block from dynamic-personal.md for admin', () => {
    const out = loadAndRenderPrompt(SHARED, 'dynamic-personal', {
      CURRENT_USER: 'a', AGENT_NAME: 'b', PERSONA: 'c',
      USER_CWD: '/x',
      IF_PERSONA: true, IF_NO_PERSONA: false,
      IF_NOT_ADMIN: false,
    });
    expect(out).not.toContain('系统级硬约束');
    expect(out).not.toContain('工作目录限制');
  });

  it('loads static.md verbatim', () => {
    const s = loadPrompt(SHARED, 'static');
    expect(s).toContain('# 语言');
    expect(s).toContain('# 记忆系统');
  });

  it('static.md no longer hardcodes stale local-runtime assumptions', () => {
    const s = loadPrompt(SHARED, 'static');
    expect(s).not.toContain('agent-saas 服务端不注入任何带尖括号');
    expect(s).not.toContain('工具调用被权限模式拒绝即用户主动拒绝');
    expect(s).not.toContain('工作区内置 venv');
    // 2026-07-03 <current-runtime> 段已删（status 快照恒 provisioning 恒错），
    // 防幽灵标签回归：static.md 不得再预授信任何平台从不拼装的标签名
    expect(s).not.toContain('<current-runtime>');
    expect(s).toContain('当前workspace运行态');
    expect(s).toContain('WaitForWorkspaceReady');
  });
});
