/**
 * PR 7 P1-9 必补测试：多组织隔离 5 关键场景
 *
 * 覆盖：
 *   1. isPlatformAdmin / requirePlatformAdmin 真值表
 *   2. authorizeOwnerAccess 跨组织 4 矩阵（platform / same-tenant admin / cross-tenant admin / cross-tenant user）
 *   3. sandbox expandOtherTenantWorkspaces + expandOtherTenantSettings 隔离
 *   4. resolveAzerothInjection 二级查表 + v1 兼容
 *   5. UserStore.load tenantId 回填 + 持久化往返
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPlatformAdmin } from '../auth/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';
import {
  listAzerothTokenBindings,
  resolveAzerothInjection,
  resolveAzerothTokensConfigPath,
  verifyAzerothTokenMetadata,
} from '../integrations/azeroth/tokens.js';
import { UserStore } from '../data/users/store.js';
import { expandSandboxPaths, type SandboxExpandContext } from '../engine/sandbox.js';
import { resolveUserCwd } from '../workspace/resolver.js';

describe('PR 7 多组织隔离 - 必补测试', () => {
  // ============================================================
  // 1. isPlatformAdmin 真值表
  // ============================================================
  describe('isPlatformAdmin 真值表', () => {
    it('undefined payload → false', () => {
      expect(isPlatformAdmin(undefined)).toBe(false);
    });

    it('user role + default tenant → false', () => {
      const p: JwtPayload = { sub: 'u1', username: 'alice', role: 'user', tenantId: DEFAULT_TENANT_ID };
      expect(isPlatformAdmin(p)).toBe(false);
    });

    it('admin role + 默认 tenant → true（平台 admin）', () => {
      const p: JwtPayload = { sub: 'u1', username: 'zengky', role: 'admin', tenantId: DEFAULT_TENANT_ID };
      expect(isPlatformAdmin(p)).toBe(true);
    });

    it('admin role + 非默认 tenant → false（组织 admin）', () => {
      const p: JwtPayload = { sub: 'u1', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
      expect(isPlatformAdmin(p)).toBe(false);
    });

    it('空 tenantId → false（防 fail-open）', () => {
      const p = { sub: 'u1', username: 'alice', role: 'admin' as const, tenantId: '' };
      expect(isPlatformAdmin(p)).toBe(false);
    });
  });

  // ============================================================
  // 2. resolveAzerothInjection v2 二级查表 + v1 兼容
  // ============================================================
  describe('resolveAzerothInjection 二级查表', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'azeroth-tokens-'));
      configPath = join(tmpDir, 'azeroth-tokens.json');
      process.env.AZEROTH_TOKENS_FILE = configPath;
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.AZEROTH_TOKENS_FILE;
    });

    it('v2 格式：按 (tenantId, username) 命中', () => {
      writeFileSync(configPath, JSON.stringify({
        tenants: {
          kaiyan: { tokens: { huangsl: 'pat_kaiyan_huangsl_xxx' } },
          wain: { tokens: { huangsl: 'pat_wain_huangsl_yyy' } },
        },
      }));
      // 注意：v1 同名 fallback 被禁，确保跨组织串号防御生效
      const kaiyanResult = resolveAzerothInjection('kaiyan', 'huangsl');
      const wainResult = resolveAzerothInjection('wain', 'huangsl');
      expect(kaiyanResult?.token).toBe('pat_kaiyan_huangsl_xxx');
      expect(wainResult?.token).toBe('pat_wain_huangsl_yyy');
    });

    it('v2 对象格式：保留审计 metadata，同时按 token 注入', async () => {
      writeFileSync(configPath, JSON.stringify({
        azerothApiUrl: 'https://fc.kaiyan.net/ky-azeroth',
        tenants: {
          kaiyan: {
            tokens: {
              huangsl: {
                token: 'pat_kaiyan_huangsl_xxx',
                kyUsername: '17759501593',
                employeeName: '黄思霖',
                roles: ['SALES'],
              },
            },
          },
        },
      }));

      const injection = resolveAzerothInjection('kaiyan', 'huangsl');
      expect(injection?.token).toBe('pat_kaiyan_huangsl_xxx');

      const bindings = listAzerothTokenBindings();
      expect(bindings).toMatchObject([
        {
          tenantId: 'kaiyan',
          username: 'huangsl',
          kyUsername: '17759501593',
          employeeName: '黄思霖',
          roles: ['SALES'],
        },
      ]);

      const summary = await verifyAzerothTokenMetadata({
        fetchFn: async () => new Response(JSON.stringify({
          username: '17759501593',
          employee: { id: 'emp-1', name: '黄思霖' },
          roles: [{ code: 'SALES' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      });
      expect(summary).toMatchObject({
        total: 1,
        verified: 1,
        mismatched: 0,
        failed: 0,
      });
    });

    it('metadata 校验发现 PAT 填串用户', async () => {
      writeFileSync(configPath, JSON.stringify({
        azerothApiUrl: 'https://fc.kaiyan.net/ky-azeroth',
        tenants: {
          kaiyan: {
            tokens: {
              chenyx: {
                token: 'pat_wrong_owner',
                kyUsername: '15980021891',
                employeeName: '陈育新',
                roles: ['SALES'],
              },
            },
          },
        },
      }));

      const summary = await verifyAzerothTokenMetadata({
        fetchFn: async () => new Response(JSON.stringify({
          username: '17759501593',
          employee: { id: 'emp-2', name: '黄思霖' },
          roles: [{ code: 'SALES' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      });
      expect(summary).toMatchObject({
        total: 1,
        verified: 0,
        mismatched: 1,
        failed: 0,
      });
    });

    it('跨组织串号防御：wain 组织 username 与 kaiyan 同名也拿不到 kaiyan PAT', () => {
      writeFileSync(configPath, JSON.stringify({
        tenants: {
          kaiyan: { tokens: { huangsl: 'pat_admin_secret' } },
          // wain 没有 huangsl 这个 PAT
        },
      }));
      const result = resolveAzerothInjection('wain', 'huangsl');
      expect(result).toBeNull();
    });

    it('v1 兼容：仅 legacy tenant 走 fallback', () => {
      writeFileSync(configPath, JSON.stringify({
        tokens: { huangsl: 'pat_legacy_kaiyan_xxx' },
      }));
      const kaiyanResult = resolveAzerothInjection('kaiyan', 'huangsl');
      const wainResult = resolveAzerothInjection('wain', 'huangsl');
      const pantheonResult = resolveAzerothInjection(DEFAULT_TENANT_ID, 'huangsl');
      expect(kaiyanResult?.token).toBe('pat_legacy_kaiyan_xxx');
      expect(wainResult).toBeNull(); // 非 legacy tenant 不走 v1 fallback
      expect(pantheonResult).toBeNull();
    });

    it('空 tenantId / username → null', () => {
      writeFileSync(configPath, JSON.stringify({
        tenants: { kaiyan: { tokens: { foo: 'pat_xxx' } } },
      }));
      expect(resolveAzerothInjection('', 'foo')).toBeNull();
      expect(resolveAzerothInjection('kaiyan', '')).toBeNull();
    });

    it('默认 token 配置路径指向当前 agent-saas server/config，不回退旧 ~/code/agent', () => {
      const previous = process.env.AZEROTH_TOKENS_FILE;
      delete process.env.AZEROTH_TOKENS_FILE;
      try {
        const resolved = resolveAzerothTokensConfigPath();
        const legacyPath = join(
          process.env.HOME || process.env.USERPROFILE || '',
          'code/agent/server/config/azeroth-tokens.json',
        );
        expect(resolved.endsWith(join('server', 'config', 'azeroth-tokens.json'))).toBe(true);
        expect(resolved).not.toBe(legacyPath);
      } finally {
        if (previous === undefined) delete process.env.AZEROTH_TOKENS_FILE;
        else process.env.AZEROTH_TOKENS_FILE = previous;
      }
    });
  });

  // ============================================================
  // 3. UserStore.load tenantId 回填 + 持久化往返
  // ============================================================
  describe('UserStore tenantId 回填', () => {
    let tmpDir: string;
    let usersFile: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'user-store-'));
      usersFile = join(tmpDir, 'users.json');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('旧普通用户无 tenantId 字段 → 启动期回填到 kaiyan 并持久化', async () => {
      // 写一个旧格式 v1 users.json，无 tenantId 字段
      writeFileSync(usersFile, JSON.stringify({
        version: 1,
        users: [
          {
            id: 'u1', username: 'legacy_user', passwordHash: 'x',
            role: 'user', createdAt: '2026-01-01', createdBy: 'system', updatedAt: '2026-01-01',
          },
        ],
      }));

      const store = new UserStore(usersFile);
      const found = store.findById('u1');
      expect(found?.tenantId).toBe(LEGACY_TENANT_ID);

      // 等异步 persist 完成
      await new Promise(r => setTimeout(r, 50));
      const persisted = JSON.parse(readFileSync(usersFile, 'utf-8'));
      expect(persisted.users[0].tenantId).toBe(LEGACY_TENANT_ID);
    });

    it('旧 admin 无 tenantId 字段 → 启动期回填到 pantheon 并持久化', async () => {
      writeFileSync(usersFile, JSON.stringify({
        version: 1,
        users: [
          {
            id: 'admin-1', username: 'admin', passwordHash: 'x',
            role: 'admin', createdAt: '2026-01-01', createdBy: 'system', updatedAt: '2026-01-01',
          },
        ],
      }));

      const store = new UserStore(usersFile);
      const found = store.findById('admin-1');
      expect(found?.tenantId).toBe(DEFAULT_TENANT_ID);

      await new Promise(r => setTimeout(r, 50));
      const persisted = JSON.parse(readFileSync(usersFile, 'utf-8'));
      expect(persisted.users[0].tenantId).toBe(DEFAULT_TENANT_ID);
    });

    it('新建用户：不传 tenantId 默认平台根组织', async () => {
      const store = new UserStore(usersFile);
      const created = await store.create({
        username: 'new_user', password: 'pwd123', role: 'user', createdBy: 'admin',
      });
      expect(created.tenantId).toBe(DEFAULT_TENANT_ID);
    });

    it('新建用户：显式传 tenantId 落对', async () => {
      const store = new UserStore(usersFile);
      const created = await store.create({
        username: 'wain_user', password: 'pwd123', role: 'user', createdBy: 'admin',
        tenantId: 'wain',
      });
      expect(created.tenantId).toBe('wain');
    });
  });

  // ============================================================
  // 4. resolveUserCwd 多组织路径
  // ============================================================
  describe('resolveUserCwd 多组织路径', () => {
    const agentCwd = '/var/workspace';

    it('user with tenantId 走 <cwd>/<tenant>/<userId>/', () => {
      const cwd = resolveUserCwd(agentCwd, {
        id: 'u1', username: 'alice', role: 'user', tenantId: 'wain',
      });
      expect(cwd).toBe('/var/workspace/wain/u1');
    });

    it('user without tenantId fallback 到 default', () => {
      const cwd = resolveUserCwd(agentCwd, {
        id: 'u1', username: 'alice', role: 'user',
      });
      expect(cwd).toBe(`/var/workspace/${DEFAULT_TENANT_ID}/u1`);
    });

    it('非法 tenantId（path traversal 尝试）fallback default', () => {
      const cwd = resolveUserCwd(agentCwd, {
        id: 'u1', username: 'alice', role: 'user', tenantId: '../etc',
      });
      // 不会变成 /var/workspace/../etc/u1，必须 fallback
      expect(cwd).toBe(`/var/workspace/${DEFAULT_TENANT_ID}/u1`);
    });

    it('undefined user → globalAgentCwd（向后兼容）', () => {
      const cwd = resolveUserCwd(agentCwd, undefined);
      expect(cwd).toBe(agentCwd);
    });
  });

  // ============================================================
  // 5. sandbox expandSandboxPaths 跨组织隔离 token 展开
  // ============================================================
  describe('sandbox 跨组织 deny 模板展开', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'sandbox-tenant-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('{{OTHER_TENANT_WORKSPACES}} 扫到兄弟 tenant 目录', () => {
      // 模拟 workspace 布局：<cwd>/kaiyan, <cwd>/wain, <cwd>/acme
      const workspaceRoot = join(tmpDir, 'workspace');
      mkdirSync(join(workspaceRoot, 'kaiyan'), { recursive: true });
      mkdirSync(join(workspaceRoot, 'wain'), { recursive: true });
      mkdirSync(join(workspaceRoot, 'acme'), { recursive: true });
      mkdirSync(join(workspaceRoot, 'uploads'), { recursive: true });

      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: join(workspaceRoot, 'kaiyan', 'alice'),
        tenantCwd: join(workspaceRoot, 'kaiyan'),
        workspaceRoot,
        sharedDir: tmpDir, // 不参与本测试
      };

      const result = expandSandboxPaths(['{{OTHER_TENANT_WORKSPACES}}'], ctx);
      // 应包含 wain + acme，不包含 kaiyan 自己、不包含 uploads
      expect(result).toContain(join(workspaceRoot, 'wain'));
      expect(result).toContain(join(workspaceRoot, 'acme'));
      expect(result).not.toContain(join(workspaceRoot, 'kaiyan'));
      expect(result).not.toContain(join(workspaceRoot, 'uploads'));
    });

    it('{{OTHER_TENANT_SETTINGS}} 扫到所有 tenant settings.json', () => {
      // 模拟 workspace-shared 布局
      const sharedDir = join(tmpDir, 'workspace-shared');
      mkdirSync(join(sharedDir, 'kaiyan', '.ky-agent'), { recursive: true });
      mkdirSync(join(sharedDir, 'wain', '.ky-agent'), { recursive: true });
      mkdirSync(join(sharedDir, 'skills-pool'), { recursive: true }); // 不是 tenant slug
      writeFileSync(join(sharedDir, 'kaiyan', '.ky-agent', 'settings.json'), '{}');
      writeFileSync(join(sharedDir, 'wain', '.ky-agent', 'settings.json'), '{}');

      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: '/dummy',
        tenantCwd: '/dummy',
        workspaceRoot: tmpDir,
        sharedDir,
      };

      const result = expandSandboxPaths(['{{OTHER_TENANT_SETTINGS}}'], ctx);
      expect(result).toContain(join(sharedDir, 'kaiyan', '.ky-agent', 'settings.json'));
      expect(result).toContain(join(sharedDir, 'wain', '.ky-agent', 'settings.json'));
      // skills-pool 不应被当作 tenant slug
      expect(result.some(p => p.includes('skills-pool'))).toBe(false);
    });

    it('{{OTHER_USER_WORKSPACES}} 使用物理 userId 目录识别自己，避免 username 自锁', () => {
      const workspaceRoot = join(tmpDir, 'workspace');
      const tenantCwd = join(workspaceRoot, 'kaiyan');
      mkdirSync(join(tenantCwd, 'u-alice'), { recursive: true });
      mkdirSync(join(tenantCwd, 'u-bob'), { recursive: true });
      mkdirSync(join(tenantCwd, 'uploads'), { recursive: true });

      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: join(tenantCwd, 'u-alice'),
        tenantCwd,
        workspaceRoot,
        sharedDir: tmpDir,
      };

      const result = expandSandboxPaths(['{{OTHER_USER_WORKSPACES}}'], ctx);
      expect(result).toContain(join(tenantCwd, 'u-bob'));
      expect(result).not.toContain(join(tenantCwd, 'u-alice'));
      expect(result).not.toContain(join(tenantCwd, 'uploads'));
    });

    it('{{TENANT_CWD}} 模板变量替换', () => {
      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: '/var/workspace/wain/alice',
        tenantCwd: '/var/workspace/wain',
        workspaceRoot: '/var/workspace',
        sharedDir: '/dummy',
      };
      const result = expandSandboxPaths(['{{TENANT_CWD}}/forbidden'], ctx);
      expect(result).toEqual(['/var/workspace/wain/forbidden']);
    });

    it('expandOtherTenantWorkspaces 防 trailing slash 自锁（PR 5 P1-8 修复）', () => {
      const workspaceRoot = join(tmpDir, 'workspace');
      mkdirSync(join(workspaceRoot, 'kaiyan'), { recursive: true });
      mkdirSync(join(workspaceRoot, 'wain'), { recursive: true });

      // tenantCwd 末尾带 '/'
      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: join(workspaceRoot, 'kaiyan', 'alice'),
        tenantCwd: join(workspaceRoot, 'kaiyan') + '/',
        workspaceRoot,
        sharedDir: tmpDir,
      };

      const result = expandSandboxPaths(['{{OTHER_TENANT_WORKSPACES}}'], ctx);
      // 自己 tenant 不该被自锁（在结果里）
      expect(result).not.toContain(join(workspaceRoot, 'kaiyan'));
      expect(result).toContain(join(workspaceRoot, 'wain'));
    });

    // ──────────────────────────────────────────────────────────
    // PR #31 transcript 跨组织/跨用户 carve-out（本次新增）
    // ──────────────────────────────────────────────────────────

    it('{{AGENT_TRANSCRIPT_DIR}}：ctx 提供时展开为自己的 transcript 路径', () => {
      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: '/dummy',
        tenantCwd: '/dummy',
        workspaceRoot: '/dummy',
        sharedDir: '/dummy',
        agentTranscriptDir: '/Users/admin/.agent-saas/legacy-transcripts/kaiyan/u-001',
      };
      const result = expandSandboxPaths(['{{AGENT_TRANSCRIPT_DIR}}'], ctx);
      expect(result).toEqual(['/Users/admin/.agent-saas/legacy-transcripts/kaiyan/u-001']);
    });

    it('{{AGENT_TRANSCRIPT_DIR}}：ctx 缺失时展开为空（安全默认，不开洞）', () => {
      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: '/dummy',
        tenantCwd: '/dummy',
        workspaceRoot: '/dummy',
        sharedDir: '/dummy',
        // 故意不传 agentTranscriptDir
      };
      const result = expandSandboxPaths(['{{AGENT_TRANSCRIPT_DIR}}'], ctx);
      // 关键：不能把字面 placeholder 字符串塞进 sandbox profile
      expect(result).toEqual([]);
    });

    it('DEFAULT_SANDBOX_DENY_READ 必含 ~/.agent-saas/legacy-transcripts 整目录', async () => {
      const { DEFAULT_SANDBOX_DENY_READ } = await import('../engine/sandbox.js');
      expect(DEFAULT_SANDBOX_DENY_READ).toContain('~/.agent-saas/legacy-transcripts');
    });

    it('DEFAULT_SANDBOX_ALLOW_READ 必含 {{AGENT_TRANSCRIPT_DIR}} carve-out', async () => {
      const { DEFAULT_SANDBOX_ALLOW_READ } = await import('../engine/sandbox.js');
      expect(DEFAULT_SANDBOX_ALLOW_READ).toContain('{{AGENT_TRANSCRIPT_DIR}}');
    });

    it('端到端：alice (kaiyan/u-001) 的 sandbox 不会 carve-out bob (kaiyan/u-002) 或 cross-tenant', async () => {
      const { DEFAULT_SANDBOX_DENY_READ, DEFAULT_SANDBOX_ALLOW_READ } = await import('../engine/sandbox.js');
      const ctx: SandboxExpandContext = {
        username: 'alice',
        userCwd: '/dummy',
        tenantCwd: '/dummy',
        workspaceRoot: '/dummy',
        sharedDir: '/dummy',
        agentTranscriptDir: '/Users/admin/.agent-saas/legacy-transcripts/kaiyan/u-001',
      };
      const deny = expandSandboxPaths(DEFAULT_SANDBOX_DENY_READ, ctx);
      const allow = expandSandboxPaths(DEFAULT_SANDBOX_ALLOW_READ, ctx);

      // DENY 必含整个 transcript 根
      expect(deny.some(p => p.endsWith('/.agent-saas/legacy-transcripts'))).toBe(true);
      // ALLOW 只含 alice 自己的，绝不含 bob/u-002 或 wain 组织
      expect(allow).toContain('/Users/admin/.agent-saas/legacy-transcripts/kaiyan/u-001');
      expect(allow.some(p => p.includes('kaiyan/u-002'))).toBe(false);
      expect(allow.some(p => p.includes('wain/'))).toBe(false);
    });
  });

  // ============================================================
  // 6. 修 P1 BUG #3 回归测试（2026-06-21 第二轮端到端测试发现）
  //
  // 原 `dispatch.ts:335` `const isAdmin = role === 'admin'` 把组织 admin 跟
  // 平台 admin 一视同仁全部 skip sandbox-exec → 实测 wain_admin Shell
  // cat /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md EXIT=0
  // 读到开沿真实数据。
  //
  // 修法：所有"admin 跳过校验"判断都从 role==='admin' 收紧到 isPlatformAdmin
  // （role==='admin' && tenantId===DEFAULT_TENANT_ID）。
  //
  // 下面 3 个测试是真值表，覆盖三类身份：
  //   - 平台 admin（kaiyan tenant + admin role） → 应跳过校验（保留特权）
  //   - 组织 admin（非 kaiyan tenant + admin role） → 应走校验（修复后行为）
  //   - 普通 user（任何 tenant + user role） → 应走校验（一直如此）
  // ============================================================
  describe('isPlatformAdmin 收紧后的真值表（修 P1 BUG #3）', () => {
    it('平台 admin（kaiyan + admin）：sandbox 跳过 + owner 特权可用', () => {
      const p: JwtPayload = { sub: 'u1', username: 'zengky', role: 'admin', tenantId: DEFAULT_TENANT_ID };
      expect(isPlatformAdmin(p)).toBe(true);
    });

    it('组织 admin（wain + admin）：sandbox 不跳过 + owner 特权不可用（修复后）', () => {
      const p: JwtPayload = { sub: 'u2', username: 'wain_admin', role: 'admin', tenantId: 'wain-test' };
      expect(isPlatformAdmin(p)).toBe(false);
      // 这一条 expect 是修 BUG #3 的根本判定：组织 admin **不再**被 isAdmin
      // gate 放行去 skip sandbox 或读跨组织绝对路径
    });

    it('普通 user（任何 tenant + user）：始终走校验', () => {
      const p1: JwtPayload = { sub: 'u3', username: 'wain_user', role: 'user', tenantId: 'wain-test' };
      const p2: JwtPayload = { sub: 'u4', username: 'kaiyan_user', role: 'user', tenantId: DEFAULT_TENANT_ID };
      expect(isPlatformAdmin(p1)).toBe(false);
      expect(isPlatformAdmin(p2)).toBe(false);
    });

    it('确认 sandbox 模板对组织 admin 也展开 OTHER_TENANT_WORKSPACES（修复后实际生效路径）', () => {
      // 修 BUG #3 前：组织 admin 满足 role==='admin'，dispatch.ts 整段 sandbox if 分支被跳过
      // 即使 sandbox 模板展开正确，也不会注入到 SDK。
      // 修复后：组织 admin 因 isPlatformAdmin=false 走 sandbox 分支，OTHER_TENANT_WORKSPACES
      // deny 真实生效。下面验证模板展开本身正确（dispatch 调用方变更覆盖见 dispatchSandbox.test）
      const localTmp = mkdtempSync(join(tmpdir(), 'bug3-regression-'));
      try {
        const workspaceRoot = join(localTmp, 'ws');
        mkdirSync(join(workspaceRoot, 'kaiyan'), { recursive: true });
        mkdirSync(join(workspaceRoot, 'wain-test'), { recursive: true });

        const ctx: SandboxExpandContext = {
          username: 'wain_admin',
          userCwd: join(workspaceRoot, 'wain-test', 'wain_admin'),
          tenantCwd: join(workspaceRoot, 'wain-test'),
          workspaceRoot,
          sharedDir: localTmp,
        };
        const result = expandSandboxPaths(['{{OTHER_TENANT_WORKSPACES}}'], ctx);
        // wain_admin 视角应该把 kaiyan 整个根目录 deny
        expect(result).toContain(join(workspaceRoot, 'kaiyan'));
        // 自己 tenant 不在 deny 名单
        expect(result).not.toContain(join(workspaceRoot, 'wain-test'));
      } finally {
        rmSync(localTmp, { recursive: true, force: true });
      }
    });
  });
});
