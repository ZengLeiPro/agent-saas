/**
 * McpConfigStore 直接单元测试（真实临时目录 + 真实文件读写，零 mock 依赖）。
 *
 * 与现有测试的分工：
 * - mcpRouterTenantIsolation / mcpRoutesCoverage / mcpSecretsTenantIsolation：
 *   HTTP 路由层（express + 权限 + vault E2E），只间接触达 store。
 * - mcpOAuthService：OAuth 授权流程服务层。
 * - tenantDeletion：deleteTenantResources 编排层，仅浅断言 serversRemoved 计数。
 *
 * 本文件补 store 本体未覆盖的行为：
 * - OAuth connection 读写 / 列表 / 按 server 反查 / 按 pendingState 反查 / 删除
 * - removeUserData / removeTenantData 级联清理（删除对象消失 + 无关对象完好）
 * - setServerSecretRef 数据完整性检查（含 user-scope 拒写）与 upsert 保留语义
 * - buildUserMcpServers + materializeSecrets 矩阵（scope × target × prefix）
 *   及 workspace 本地 settings.json 同名覆盖
 * - load 旧记录 tenantId 迁移回填 / 损坏 JSON → loadFailed 且 persist 拒写
 * - persist tmp+rename 原子写（无残留 tmp、权限 0600、round-trip 完整）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GLOBAL_TENANT_ID,
  McpConfigStore,
  type ManagedMcpServer,
  type McpOAuthConnectionRecord,
  type McpSecretRequirement,
} from '../data/mcpConfig.js';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import type { McpServerConfig } from '../mcp/clientManager.js';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-config-store-'));
  filePath = join(tmpDir, 'mcp-config.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeServer(id: string, overrides: Partial<ManagedMcpServer> = {}): ManagedMcpServer {
  return {
    id,
    name: id,
    tenantId: 'wain',
    config: { type: 'streamable-http', url: `https://${id}.example.com/mcp` },
    ...overrides,
  };
}

function userTokenReq(overrides: Partial<McpSecretRequirement> = {}): McpSecretRequirement {
  return { key: 'token', label: 'Token', target: 'header', name: 'Authorization', scope: 'user', ...overrides };
}

function makeOAuthRecord(serverId: string, overrides: Partial<McpOAuthConnectionRecord> = {}): McpOAuthConnectionRecord {
  return {
    serverId,
    tenantId: 'wain',
    status: 'connected',
    redirectUrl: 'https://app.example.com/oauth/callback',
    returnTo: '/settings/mcp',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function readJson(): { servers: Record<string, ManagedMcpServer>; users: Record<string, unknown>; configVersion: number } {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

describe('McpConfigStore OAuth connections', () => {
  it('setUserOAuthConnection 写入后可读回；未知用户/server 返回 undefined；读回是隔离副本', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('gh'));
    const record = makeOAuthRecord('gh', { status: 'pending', pendingState: 'state-alice' });
    await store.setUserOAuthConnection('alice', record);

    const readBack = store.getUserOAuthConnection('alice', 'gh');
    expect(readBack).toEqual(record);
    expect(store.getUserOAuthConnection('alice', 'nope')).toBeUndefined();
    expect(store.getUserOAuthConnection('bob', 'gh')).toBeUndefined();

    // clone 隔离：改返回值不能污染 store 内部状态
    readBack!.status = 'error';
    expect(store.getUserOAuthConnection('alice', 'gh')!.status).toBe('pending');
  });

  it('listUserOAuthConnections / listOAuthConnectionsForServer / findUserOAuthConnectionByState', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('gh'));
    await store.upsertServer(makeServer('notion_like'));
    await store.setUserOAuthConnection('alice', makeOAuthRecord('gh'));
    await store.setUserOAuthConnection('alice', makeOAuthRecord('notion_like', { status: 'pending', pendingState: 'state-a-notion' }));
    await store.setUserOAuthConnection('bob', makeOAuthRecord('gh', { status: 'pending', pendingState: 'state-b-gh' }));

    // 按用户列表
    expect(store.listUserOAuthConnections('alice').map(c => c.serverId).sort()).toEqual(['gh', 'notion_like']);
    expect(store.listUserOAuthConnections('carol')).toEqual([]);

    // 按 server 反查所有用户
    const forGh = store.listOAuthConnectionsForServer('gh');
    expect(forGh.map(x => x.username).sort()).toEqual(['alice', 'bob']);
    expect(forGh.every(x => x.connection.serverId === 'gh')).toBe(true);
    expect(store.listOAuthConnectionsForServer('unknown')).toEqual([]);

    // 按 pendingState 反查（OAuth callback 路径）
    const hit = store.findUserOAuthConnectionByState('state-b-gh');
    expect(hit).toBeDefined();
    expect(hit!.username).toBe('bob');
    expect(hit!.connection.serverId).toBe('gh');
    expect(store.findUserOAuthConnectionByState('state-unknown')).toBeUndefined();
  });

  it('deleteUserOAuthConnection 只删指定连接；不存在时是 no-op（不 bump version）', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('gh'));
    await store.upsertServer(makeServer('other'));
    await store.setUserOAuthConnection('alice', makeOAuthRecord('gh'));
    await store.setUserOAuthConnection('alice', makeOAuthRecord('other'));
    await store.setUserOAuthConnection('bob', makeOAuthRecord('gh'));

    await store.deleteUserOAuthConnection('alice', 'gh');

    // 删除对象消失
    expect(store.getUserOAuthConnection('alice', 'gh')).toBeUndefined();
    // 无关对象完好：同用户其他连接 + 其他用户同 server 连接
    expect(store.getUserOAuthConnection('alice', 'other')).toBeDefined();
    expect(store.getUserOAuthConnection('bob', 'gh')).toBeDefined();

    const versionBefore = store.getConfigVersion();
    await store.deleteUserOAuthConnection('alice', 'gh'); // 已不存在
    await store.deleteUserOAuthConnection('ghost', 'gh'); // 用户不存在
    expect(store.getConfigVersion()).toBe(versionBefore);
  });
});

describe('用户记录首次播种默认启用列表按 tenant 过滤（2026-07-19 修复回归）', () => {
  // 历史缺陷：setUserSecretRef/setUserOAuthConnection 首次创建用户记录时
  // 用不带 tenantId 的 defaultEnabledServerIds() 播种，其他租户 enabledByDefault
  // server 的 id 会被冻结进该用户的显式启用列表（跨租户 id 泄漏 + stale 引用）。
  it('setUserSecretRef 传 tenantId：播种只含本租户 + 全局默认 server，不含其他租户', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('wain_default', { tenantId: 'wain', enabledByDefault: true, secretRequirements: [userTokenReq()] }));
    await store.upsertServer(makeServer('kaiyan_default', { tenantId: 'kaiyan', enabledByDefault: true }));
    await store.upsertServer(makeServer('global_default', { tenantId: GLOBAL_TENANT_ID, enabledByDefault: true }));

    // alice（wain 租户）首次通过 setUserSecretRef 创建用户记录
    await store.setUserSecretRef('alice', 'wain_default', 'token', 'ref-a', 'wain');

    const cfg = store.getUserConfig('alice');
    expect([...cfg.enabledServers].sort()).toEqual(['global_default', 'wain_default']);
    expect(cfg.enabledServers).not.toContain('kaiyan_default');
    expect(cfg.secretRefs).toEqual({ wain_default: { token: 'ref-a' } });
  });

  it('setUserOAuthConnection 按 record.tenantId 播种，跨租户默认 server 不进列表', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('wain_default', { tenantId: 'wain', enabledByDefault: true }));
    await store.upsertServer(makeServer('kaiyan_default', { tenantId: 'kaiyan', enabledByDefault: true }));
    await store.upsertServer(makeServer('global_default', { tenantId: GLOBAL_TENANT_ID, enabledByDefault: true }));

    // bob 首次通过 OAuth 连接创建用户记录，record.tenantId='wain'（makeOAuthRecord 默认）
    await store.setUserOAuthConnection('bob', makeOAuthRecord('wain_default'));

    const cfg = store.getUserConfig('bob');
    expect([...cfg.enabledServers].sort()).toEqual(['global_default', 'wain_default']);
    expect(cfg.enabledServers).not.toContain('kaiyan_default');
  });
});

describe('McpConfigStore removeUserData', () => {
  it('删除已有用户返回 true 且数据从盘上消失；重复删/删不存在返回 false 且不写盘', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('srv', { secretRequirements: [userTokenReq()] }));
    await store.setUserEnabledServers('alice', ['srv']);
    await store.setUserSecretRef('alice', 'srv', 'token', 'ref-alice');
    await store.setUserEnabledServers('bob', ['srv']);
    await store.setUserSecretRef('bob', 'srv', 'token', 'ref-bob');

    await expect(store.removeUserData('alice')).resolves.toBe(true);

    // 删除对象消失（内存 + 磁盘）
    expect(store.getUserConfig('alice').enabledServers).toEqual([]);
    expect(store.getUserConfig('alice').secretRefs).toEqual({});
    expect('alice' in readJson().users).toBe(false);
    // 无关对象完好
    expect(store.getUserConfig('bob').enabledServers).toEqual(['srv']);
    expect(store.getUserConfig('bob').secretRefs).toEqual({ srv: { token: 'ref-bob' } });
    expect(store.getServer('srv')).toBeDefined();

    const versionBefore = store.getConfigVersion();
    await expect(store.removeUserData('alice')).resolves.toBe(false);
    await expect(store.removeUserData('ghost')).resolves.toBe(false);
    expect(store.getConfigVersion()).toBe(versionBefore);
  });
});

describe('McpConfigStore removeTenantData 级联', () => {
  it('删除组织 server + 组织用户，并级联清理留存用户的 enabledServers/secretRefs/oauthConnections', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('wain_srv', { tenantId: 'wain', secretRequirements: [userTokenReq()] }));
    await store.upsertServer(makeServer('alice_private', { tenantId: 'wain', ownerUsername: 'alice' }));
    await store.upsertServer(makeServer('kaiyan_srv', { tenantId: 'kaiyan', secretRequirements: [userTokenReq()] }));
    await store.upsertServer(makeServer('global_srv', { tenantId: GLOBAL_TENANT_ID }));

    // alice 属于 wain（将被整体删除）
    await store.setUserEnabledServers('alice', ['wain_srv', 'alice_private', 'global_srv']);
    await store.setUserSecretRef('alice', 'wain_srv', 'token', 'ref-aw');
    await store.setUserOAuthConnection('alice', makeOAuthRecord('wain_srv'));
    // bob 属于 kaiyan（留存用户，但持有对 wain_srv 的 stale 引用）
    await store.setUserEnabledServers('bob', ['kaiyan_srv', 'wain_srv', 'global_srv']);
    await store.setUserSecretRef('bob', 'wain_srv', 'token', 'ref-bw');
    await store.setUserSecretRef('bob', 'kaiyan_srv', 'token', 'ref-bk');
    await store.setUserOAuthConnection('bob', makeOAuthRecord('wain_srv'));
    await store.setUserOAuthConnection('bob', makeOAuthRecord('kaiyan_srv', { tenantId: 'kaiyan' }));

    const report = await store.removeTenantData('wain', ['alice']);
    // wain_srv（tenantId 命中）+ alice_private（ownerUsername 命中）
    expect(report).toEqual({ serversRemoved: 2, usersRemoved: 1 });

    // 删除对象消失
    expect(store.getServer('wain_srv')).toBeUndefined();
    expect(store.getServer('alice_private')).toBeUndefined();
    expect('alice' in readJson().users).toBe(false);

    // 无关对象完好
    expect(store.getServer('kaiyan_srv')).toBeDefined();
    expect(store.getServer('global_srv')).toBeDefined();

    // 留存用户 bob 的级联清理：stale 引用被剔除，本组织数据原样保留
    const bob = store.getUserConfig('bob');
    expect(bob.enabledServers).toEqual(['kaiyan_srv', 'global_srv']);
    expect(bob.secretRefs).toEqual({ kaiyan_srv: { token: 'ref-bk' } });
    expect(Object.keys(bob.oauthConnections ?? {})).toEqual(['kaiyan_srv']);

    // 磁盘状态与内存一致
    const onDisk = readJson();
    expect(Object.keys(onDisk.servers).sort()).toEqual(['global_srv', 'kaiyan_srv']);
    expect(Object.keys(onDisk.users)).toEqual(['bob']);
  });

  it('无匹配 server/user 时返回 0/0 且不 bump version、不写盘', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('keep_srv', { tenantId: 'kaiyan' }));
    await store.setUserEnabledServers('bob', ['keep_srv']);
    const versionBefore = store.getConfigVersion();
    const diskBefore = readFileSync(filePath, 'utf-8');

    await expect(store.removeTenantData('ghost_tenant', ['ghost_user'])).resolves.toEqual({ serversRemoved: 0, usersRemoved: 0 });

    expect(store.getConfigVersion()).toBe(versionBefore);
    expect(readFileSync(filePath, 'utf-8')).toBe(diskBefore);
    expect(store.getServer('keep_srv')).toBeDefined();
    expect(store.getUserConfig('bob').enabledServers).toEqual(['keep_srv']);
  });
});

describe('McpConfigStore setServerSecretRef', () => {
  it('user-scope requirement → 拒写并提示 Use setUserSecretRef，且未落任何 ref', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('srv', { secretRequirements: [userTokenReq()] }));

    await expect(store.setServerSecretRef('srv', 'token', 'ref-x'))
      .rejects.toThrow('Use setUserSecretRef for user-scope secrets');
    expect(store.getServer('srv')!.secretRefs).toBeUndefined();
  });

  it('server 不存在 / requirement 不存在 → 抛对应错误', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('srv', { secretRequirements: [userTokenReq({ key: 'k', scope: 'tenant' })] }));

    await expect(store.setServerSecretRef('missing', 'k', 'ref')).rejects.toThrow('MCP server not found');
    await expect(store.setServerSecretRef('srv', 'wrong_key', 'ref')).rejects.toThrow('MCP secret requirement not found');
  });

  it('tenant/global scope 写入成功；upsertServer 不带 secretRefs 时保留既有 server 级 refs', async () => {
    const store = new McpConfigStore(filePath);
    const base = makeServer('srv', {
      secretRequirements: [
        userTokenReq({ key: 'org_pat', scope: 'tenant', target: 'header', name: 'X-Org' }),
        userTokenReq({ key: 'platform_key', scope: 'global', target: 'header', name: 'X-Platform' }),
      ],
    });
    await store.upsertServer(base);
    await store.setServerSecretRef('srv', 'org_pat', 'ref-tenant-1');
    await store.setServerSecretRef('srv', 'platform_key', 'ref-global-1');
    expect(store.getServer('srv')!.secretRefs).toEqual({ org_pat: 'ref-tenant-1', platform_key: 'ref-global-1' });

    // 管理端重新保存 server（不带 secretRefs）不得清空既有绑定
    await store.upsertServer({ ...base, description: 'resaved' });
    expect(store.getServer('srv')!.secretRefs).toEqual({ org_pat: 'ref-tenant-1', platform_key: 'ref-global-1' });
    // 磁盘上同样保留
    expect(readJson().servers['srv'].secretRefs).toEqual({ org_pat: 'ref-tenant-1', platform_key: 'ref-global-1' });
  });
});

describe('McpConfigStore buildUserMcpServers + materializeSecrets', () => {
  it('scope(user/tenant/global) × target(env/header) × prefix 矩阵物化正确', async () => {
    const store = new McpConfigStore(filePath);
    // stdio server：只接受 target=env；header requirement 应被跳过
    await store.upsertServer(makeServer('tool_stdio', {
      config: { command: 'node', args: ['server.js'] },
      secretRequirements: [
        userTokenReq({ key: 'a', scope: 'user', target: 'env', name: 'API_KEY' }),
        userTokenReq({ key: 'b', scope: 'user', target: 'header', name: 'X-Skipped' }),
        userTokenReq({ key: 'c', scope: 'tenant', target: 'env', name: 'TENANT_KEY' }),
      ],
    }));
    // http server：只接受 target=header；env requirement 应被跳过；prefix 可选
    await store.upsertServer(makeServer('tool_http', {
      secretRequirements: [
        userTokenReq({ key: 'h', scope: 'user', target: 'header', name: 'Authorization', prefix: 'Bearer ' }),
        userTokenReq({ key: 'e', scope: 'user', target: 'env', name: 'ENV_SKIPPED' }),
        userTokenReq({ key: 'g', scope: 'global', target: 'header', name: 'X-Global' }),
        userTokenReq({ key: 'unbound', scope: 'user', target: 'header', name: 'X-Unbound' }),
      ],
    }));

    await store.setUserEnabledServers('alice', ['tool_stdio', 'tool_http']);
    await store.setUserSecretRef('alice', 'tool_stdio', 'a', 'ref-user-a');
    await store.setUserSecretRef('alice', 'tool_stdio', 'b', 'ref-user-b');
    await store.setUserSecretRef('alice', 'tool_http', 'h', 'ref-user-h');
    await store.setUserSecretRef('alice', 'tool_http', 'e', 'ref-user-e');
    await store.setServerSecretRef('tool_stdio', 'c', 'ref-tenant-c');
    await store.setServerSecretRef('tool_http', 'g', 'ref-global-g');

    const ws = join(tmpDir, 'ws-empty');
    mkdirSync(ws, { recursive: true });
    const { mcpServers } = await store.buildUserMcpServers('alice', ws);

    const stdio = mcpServers!['tool_stdio'] as Extract<McpServerConfig, { command: string }>;
    // user-scope env + tenant-scope env 均落 envSecretRefs；header req 对 stdio 无效
    expect(stdio.envSecretRefs).toEqual({ API_KEY: 'ref-user-a', TENANT_KEY: 'ref-tenant-c' });
    expect('headerSecretRefs' in stdio).toBe(false);
    expect(JSON.stringify(stdio)).not.toContain('ref-user-b');

    const http = mcpServers!['tool_http'] as Extract<McpServerConfig, { type: 'http' | 'streamable-http' }>;
    // 带 prefix → { ref, prefix }；不带 prefix → 只有 { ref }；未绑定 → 不出现
    expect(http.headerSecretRefs).toEqual({
      Authorization: { ref: 'ref-user-h', prefix: 'Bearer ' },
      'X-Global': { ref: 'ref-global-g' },
    });
    expect('envSecretRefs' in http).toBe(false);
    expect(JSON.stringify(http)).not.toContain('ref-user-e');

    // 物化只发生在输出副本上：catalog 内的原始 config 不受污染
    expect(JSON.stringify(store.getServer('tool_http')!.config)).not.toContain('ref-user-h');
  });

  it('workspace 本地同名 server 覆盖 managed 配置；本地独有 server 追加；其余 managed 保留', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('shared_id', {
      secretRequirements: [userTokenReq({ key: 'h', prefix: 'Bearer ' })],
    }));
    await store.upsertServer(makeServer('managed_only'));
    await store.setUserEnabledServers('alice', ['shared_id', 'managed_only']);
    await store.setUserSecretRef('alice', 'shared_id', 'h', 'ref-managed-h');

    const ws = join(tmpDir, 'ws-local');
    mkdirSync(join(ws, '.ky-agent'), { recursive: true });
    writeFileSync(join(ws, '.ky-agent', 'settings.json'), JSON.stringify({
      mcpServers: {
        shared_id: { type: 'streamable-http', url: 'http://127.0.0.1:9999/mcp' },
        local_only: { command: 'echo', args: ['hi'] },
      },
    }));

    const { mcpServers } = await store.buildUserMcpServers('alice', ws);
    // 同名：本地覆盖 managed（url 换成本地，且不带 managed 物化出的 secret refs）
    expect(mcpServers!['shared_id']).toEqual({ type: 'streamable-http', url: 'http://127.0.0.1:9999/mcp' });
    // 本地独有追加、其余 managed 保留
    expect(mcpServers!['local_only']).toEqual({ command: 'echo', args: ['hi'] });
    expect((mcpServers!['managed_only'] as { url: string }).url).toBe('https://managed_only.example.com/mcp');
  });

  it('tenantId 过滤：跨组织 server 不进结果；workspace settings.json 损坏时降级为仅 managed', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('wain_srv', { tenantId: 'wain' }));
    await store.upsertServer(makeServer('kaiyan_srv', { tenantId: 'kaiyan' }));
    await store.upsertServer(makeServer('global_srv', { tenantId: GLOBAL_TENANT_ID }));
    // 不带 tenantId 的内部写入路径可留下越界 id（模拟 stale 状态）
    await store.setUserEnabledServers('alice', ['wain_srv', 'kaiyan_srv', 'global_srv']);

    const ws = join(tmpDir, 'ws-corrupt');
    mkdirSync(join(ws, '.ky-agent'), { recursive: true });
    writeFileSync(join(ws, '.ky-agent', 'settings.json'), '{ not json');

    const { mcpServers } = await store.buildUserMcpServers('alice', ws, 'wain');
    expect(Object.keys(mcpServers!).sort()).toEqual(['global_srv', 'wain_srv']);
  });
});

describe('McpConfigStore load 迁移与规范化', () => {
  it('缺 tenantId 的旧记录回填 LEGACY_TENANT_ID 并 warn；map key 覆盖 record id；requirement required 默认 true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      configVersion: 7,
      servers: {
        legacy_srv: {
          id: 'mismatched_id',
          name: '  Legacy  ',
          config: { type: 'streamable-http', url: 'https://legacy.example.com/mcp' },
          secretRequirements: [{ key: 'k', label: 'K', target: 'header', name: 'X-K', scope: 'user' }],
        },
      },
      users: {
        u1: { secretRefs: { legacy_srv: { k: 'ref-1' } } },
      },
    }));

    const store = new McpConfigStore(filePath);
    expect(store.loadFailed).toBe(false);
    expect(store.getConfigVersion()).toBe(7);

    const srv = store.getServer('legacy_srv')!;
    expect(srv.id).toBe('legacy_srv'); // map key 优先于 record 内的 id 字段
    expect(srv.tenantId).toBe(LEGACY_TENANT_ID);
    expect(srv.name).toBe('Legacy'); // trim
    expect(srv.secretRequirements![0].required).toBe(true); // 缺省回填 required

    // 用户缺失字段补默认
    const u1 = store.getUserConfig('u1');
    expect(u1.enabledServers).toEqual([]);
    expect(u1.secretRefs).toEqual({ legacy_srv: { k: 'ref-1' } });
    expect(u1.oauthConnections).toEqual({});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Migrated 1 legacy MCP server record(s)');
  });

  it('显式 tenantId（含全局 "*"）不被迁移改写，也不触发 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      configVersion: 2,
      servers: {
        g: { id: 'g', name: 'G', tenantId: GLOBAL_TENANT_ID, config: { type: 'streamable-http', url: 'https://g.example.com' } },
        w: { id: 'w', name: 'W', tenantId: 'wain', config: { command: 'echo' } },
      },
      users: {},
    }));

    const store = new McpConfigStore(filePath);
    expect(store.getServer('g')!.tenantId).toBe(GLOBAL_TENANT_ID);
    expect(store.getServer('w')!.tenantId).toBe('wain');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('McpConfigStore 损坏 JSON 防覆盖', () => {
  it('损坏 JSON → loadFailed=true，后续 mutation 不得覆盖原文件内容', async () => {
    const corrupt = '{ "version": 1, "servers": { TRUNCATED';
    writeFileSync(filePath, corrupt);

    const store = new McpConfigStore(filePath);
    expect(store.loadFailed).toBe(true);
    expect(store.listServers()).toEqual([]);

    // mutation 在内存中生效（resolve 不抛错），但 persist 必须拒写
    await store.upsertServer(makeServer('mem_only'));
    await store.setUserEnabledServers('alice', ['mem_only']);
    expect(store.getServer('mem_only')).toBeDefined();

    // 核心断言：原始损坏文件原封不动，人工修复的机会未被销毁
    expect(readFileSync(filePath, 'utf-8')).toBe(corrupt);
    // 也没有遗留 tmp 文件
    expect(readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('McpConfigStore persist 原子写', () => {
  it('tmp+rename：最终文件完整可解析、无 tmp 残留、权限 0600、新实例 round-trip 一致', async () => {
    // 用嵌套不存在的目录验证 mkdirSync recursive
    const nestedPath = join(tmpDir, 'deep', 'nested', 'mcp-config.json');
    const store = new McpConfigStore(nestedPath);
    expect(store.loadFailed).toBe(false);

    await store.upsertServer(makeServer('srv_a', { secretRequirements: [userTokenReq({ key: 'k', scope: 'tenant' })] }));
    await store.upsertServer(makeServer('srv_b', { config: { command: 'node' } }));
    await store.setServerSecretRef('srv_a', 'k', 'ref-k');
    await store.setUserEnabledServers('alice', ['srv_a', 'srv_b']);
    await store.setUserOAuthConnection('alice', makeOAuthRecord('srv_a'));

    expect(existsSync(nestedPath)).toBe(true);
    const dir = join(tmpDir, 'deep', 'nested');
    expect(readdirSync(dir).filter(f => f.startsWith('.mcp-config.') && f.endsWith('.tmp'))).toEqual([]);
    // 0600：group/other 位必须为空（umask 只减不增，断言与 umask 无关）
    expect(statSync(nestedPath).mode & 0o077).toBe(0);

    const onDisk = JSON.parse(readFileSync(nestedPath, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(Object.keys(onDisk.servers).sort()).toEqual(['srv_a', 'srv_b']);

    // round-trip：新实例读回与旧实例视图一致
    const reopened = new McpConfigStore(nestedPath);
    expect(reopened.loadFailed).toBe(false);
    expect(reopened.getConfigVersion()).toBe(store.getConfigVersion());
    expect(reopened.listServers()).toEqual(store.listServers());
    expect(reopened.getUserConfig('alice')).toEqual(store.getUserConfig('alice'));
    expect(reopened.getUserOAuthConnection('alice', 'srv_a')).toEqual(store.getUserOAuthConnection('alice', 'srv_a'));
  });

  it('并发 mutation 被 serialize：configVersion 精确计数，最终文件完整', async () => {
    const store = new McpConfigStore(filePath);
    await store.upsertServer(makeServer('base'));
    const versionBefore = store.getConfigVersion();

    await Promise.all([
      store.upsertServer(makeServer('c1')),
      store.upsertServer(makeServer('c2')),
      store.setUserEnabledServers('u1', ['base']),
      store.setUserEnabledServers('u2', ['base']),
      store.setUserOAuthConnection('u1', makeOAuthRecord('base')),
    ]);

    expect(store.getConfigVersion()).toBe(versionBefore + 5);
    const onDisk = readJson();
    expect(onDisk.configVersion).toBe(versionBefore + 5);
    expect(Object.keys(onDisk.servers).sort()).toEqual(['base', 'c1', 'c2']);
    expect(Object.keys(onDisk.users).sort()).toEqual(['u1', 'u2']);
  });
});
