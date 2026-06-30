/**
 * tenantEnv 单测：锁死子进程 env 多组织身份隔离规则（P4 防御纵深，2026-06-22）。
 *
 * 这些断言守护的产品语义：
 *   - 匿名内部调用：保留完整 process.env，兼容 cron / 内部 dispatch。
 *   - 明确 tenant（含平台 admin/kaiyan）：剔除敏感宿主 env 后从显式配置重新合并 +
 *     按 (tenantId, username) 注入 azeroth；组织没配的密钥保持缺失，
 *     下游 CLI fail-closed 报"未授权"。
 *
 * 任何对 buildTenantScopedEnv / SENSITIVE_ENV_KEYS 的回归都会在这里被门禁拦下。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTenantScopedEnv, listSensitiveEnvKeys } from '../agent/tenantEnv.js';
import type { AgentOptionsConfig } from '../agent/options.js';
import type { WorkspaceRef } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

function makeWorkspace(overrides: Partial<WorkspaceRef> = {}): WorkspaceRef {
  return {
    root: '/tmp/ws',
    executionTarget: 'server-local',
    ...overrides,
  };
}

function makeAgentOptions(overrides: Partial<AgentOptionsConfig> = {}): AgentOptionsConfig {
  return {
    agent: { cwd: '/tmp' } as AgentOptionsConfig['agent'],
    ...overrides,
  };
}

describe('buildTenantScopedEnv', () => {
  let tokensFile: string;
  let tokensDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // 清空本机 shell / 进程继承下来的所有 SENSITIVE 凭据，避免被测试逻辑透传干扰。
    // 否则 buildEnv 会把 host AZEROTH_TOKEN / OPENAI_API_KEY 等带进 env 输出，
    // 让"无 username 不注入 azeroth"等场景拿到 host 真实 PAT 而 fail。
    for (const key of listSensitiveEnvKeys()) {
      delete process.env[key];
    }
    tokensDir = mkdtempSync(join(tmpdir(), 'tenant-env-tokens-'));
    tokensFile = join(tokensDir, 'azeroth-tokens.json');
    writeFileSync(tokensFile, JSON.stringify({
      azerothApiUrl: 'http://test-azeroth/api',
      tenants: {
        pantheon: { tokens: { admin: 'pat_pantheon_admin' } },
        kaiyan: { tokens: { zenglei: 'pat_kaiyan_zenglei' } },
        'wain-test': { tokens: { wain_admin: 'pat_wain_admin' } },
      },
    }));
    process.env['AZEROTH_TOKENS_FILE'] = tokensFile;
  });

  afterEach(() => {
    // Restore env first（避免 leak 到其他测试），再清理 tokens 目录
    process.env = originalEnv;
    rmSync(tokensDir, { recursive: true, force: true });
  });

  it('platform admin strips host sensitive env, restores explicit config, and injects platform azeroth PAT', () => {
    process.env['SOME_PLATFORM_KEY'] = 'platform-secret';
    process.env['ANTHROPIC_API_KEY'] = 'host-anthropic-key';
    process.env['NPM_TOKEN'] = 'host-npm-token';
    process.env['RANDOM_VENDOR_SECRET'] = 'host-secret';

    const env = buildTenantScopedEnv(
      {
        agentOptions: makeAgentOptions({
          sharedEnv: {
            ANTHROPIC_API_KEY: 'configured-anthropic-key',
            CUSTOM_ADMIN_TOOL_ENV: 'configured-admin-env',
          },
        }),
      },
      makeWorkspace({ tenantId: DEFAULT_TENANT_ID, username: 'admin' }),
    );

    // 非敏感宿主配置保留；敏感宿主凭据不能因为 admin 默认进容器而透传。
    expect(env['SOME_PLATFORM_KEY']).toBe('platform-secret');
    expect(env['NPM_TOKEN']).toBeUndefined();
    expect(env['RANDOM_VENDOR_SECRET']).toBeUndefined();
    // 显式配置层可复原 admin 工具确实需要的 env。
    expect(env['ANTHROPIC_API_KEY']).toBe('configured-anthropic-key');
    expect(env['CUSTOM_ADMIN_TOOL_ENV']).toBe('configured-admin-env');
    // 平台组织 azeroth PAT 注入
    expect(env['AZEROTH_TOKEN']).toBe('pat_pantheon_admin');
    expect(env['AZEROTH_API_URL']).toBe('http://test-azeroth/api');
  });

  it('anonymous workspace (no tenantId) preserves full process.env (cron / internal dispatch compat)', () => {
    process.env['ANTHROPIC_API_KEY'] = 'platform-anthropic-key';
    process.env['OPENAI_API_KEY'] = 'platform-openai-key';

    const env = buildTenantScopedEnv(
      { agentOptions: makeAgentOptions() },
      makeWorkspace({ /* no tenantId, no username */ }),
    );

    expect(env['ANTHROPIC_API_KEY']).toBe('platform-anthropic-key');
    expect(env['OPENAI_API_KEY']).toBe('platform-openai-key');
    // 无 username → azeroth 不查表
    expect(env['AZEROTH_TOKEN']).toBeUndefined();
  });

  it('non-platform tenant strips SENSITIVE_ENV_KEYS leaked from process.env (no cross-tenant credential bleed)', () => {
    // brain 启动时 process.env 含开沿默认 token —— 不能继承给组织子进程
    process.env['AZEROTH_TOKEN'] = 'kaiyan_secret_pat';
    process.env['ANTHROPIC_API_KEY'] = 'kaiyan_anthropic_key';
    process.env['OPENAI_API_KEY'] = 'kaiyan_openai_key';
    process.env['GH_TOKEN'] = 'kaiyan_gh_token';
    process.env['SOME_PLATFORM_KEY'] = 'should-still-leak';  // 非 SENSITIVE：保留共享配置

    const env = buildTenantScopedEnv(
      { agentOptions: makeAgentOptions() },
      makeWorkspace({ tenantId: 'wain-test', username: 'wain_admin' }),
    );

    // 关键不变量：开沿凭据绝对不能漏给 wain
    expect(env['AZEROTH_TOKEN']).toBe('pat_wain_admin');  // 重新注入为 wain 自己的 PAT
    expect(env['AZEROTH_TOKEN']).not.toBe('kaiyan_secret_pat');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    // 非 SENSITIVE 共享配置保留（PATH / NODE_ENV / LANG 等不能删，否则工具链坏）
    expect(env['SOME_PLATFORM_KEY']).toBe('should-still-leak');
  });

  it('non-platform tenant re-merges tenantSharedEnv after stripping (per-tenant override survives strip)', () => {
    process.env['ANTHROPIC_API_KEY'] = 'kaiyan_leaked_key';

    const env = buildTenantScopedEnv(
      {
        agentOptions: makeAgentOptions({
          tenantSharedEnv: {
            'wain-test': {
              ANTHROPIC_API_KEY: 'wain_explicit_key',
              CUSTOM_TENANT_FLAG: 'wain-only',
            },
          },
        }),
      },
      makeWorkspace({ tenantId: 'wain-test', username: 'wain_admin' }),
    );

    // wain 显式配的 ANTHROPIC_API_KEY 必须 survive SENSITIVE 剔除
    expect(env['ANTHROPIC_API_KEY']).toBe('wain_explicit_key');
    expect(env['ANTHROPIC_API_KEY']).not.toBe('kaiyan_leaked_key');
    expect(env['CUSTOM_TENANT_FLAG']).toBe('wain-only');
  });

  it('non-platform tenant without configured azeroth PAT leaves AZEROTH_TOKEN unset (fail-closed at CLI)', () => {
    process.env['AZEROTH_TOKEN'] = 'kaiyan_leaked_pat';

    const env = buildTenantScopedEnv(
      { agentOptions: makeAgentOptions() },
      // wain-test 配置里没有 unknown_user 这个用户
      makeWorkspace({ tenantId: 'wain-test', username: 'unknown_user' }),
    );

    // 关键：拿不到 wain 自己的 PAT 时，绝不能 fallback 到 kaiyan 的 PAT
    expect(env['AZEROTH_TOKEN']).toBeUndefined();
  });

  it('SENSITIVE_ENV_KEYS includes the credential keys we care about (drift guard)', () => {
    const keys = listSensitiveEnvKeys();
    // 这些是 6/22 评审拍定的最小集；新增凭据时同时加 key 和测试 expect
    for (const required of [
      'AZEROTH_TOKEN', 'AZEROTH_API_URL',
      'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      'DASHSCOPE_API_KEY', 'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(keys).toContain(required);
    }
  });
});
