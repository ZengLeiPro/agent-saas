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

  it('renders dynamic-personal.md with vars and IF_NOT_ADMIN block', () => {
    const out = loadAndRenderPrompt(SHARED, 'dynamic-personal', {
      CURRENT_USER: '测试用户',
      AGENT_NAME: '测试体',
      PERSONA: '简洁',
      USER_CWD: '/tmp/x',
      IS_GIT_REPO: 'No',
      PLATFORM: 'darwin',
      RUNTIME_INFO: 'raw',
      IF_NOT_ADMIN: true,
    });
    expect(out).toContain('测试用户');
    expect(out).toContain('「测试体」');
    expect(out).toContain('系统级硬约束');
    expect(out).not.toContain('OS Version');           // O3: 已删除
    expect(out).not.toContain('{{');
  });

  it('strips IF_NOT_ADMIN block from dynamic-personal.md for admin', () => {
    const out = loadAndRenderPrompt(SHARED, 'dynamic-personal', {
      CURRENT_USER: 'a', AGENT_NAME: 'b', PERSONA: 'c',
      USER_CWD: '/x', IS_GIT_REPO: 'No', PLATFORM: 'darwin',
      RUNTIME_INFO: 'r',
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
    expect(s).toContain('<current-runtime>');
    expect(s).toContain('当前 workspace 运行态');
  });
});
