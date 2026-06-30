import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TenantCompanyInfoToolProvider, updateCompanyInfoToolDescriptor } from '../agent/tenantCompanyInfoToolProvider.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { DefaultToolPolicy } from '../runtime/toolPolicy.js';
import type { RunContext } from '../runtime/types.js';
import type { UserIdentity } from '../types/index.js';

const PLATFORM_ADMIN: UserIdentity = {
  id: 'u-platform',
  username: 'admin',
  role: 'admin',
  tenantId: DEFAULT_TENANT_ID,
};

const WAIN_ADMIN: UserIdentity = {
  id: 'u-wain-admin',
  username: 'wain_admin',
  role: 'admin',
  tenantId: 'wain',
};

const WAIN_USER: UserIdentity = {
  id: 'u-wain-user',
  username: 'wain_user',
  role: 'user',
  tenantId: 'wain',
};

describe('TenantCompanyInfoToolProvider', () => {
  let root: string;
  let sharedDir: string;
  let tenantStore: TenantStore;
  let provider: TenantCompanyInfoToolProvider;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'tenant-company-info-tool-'));
    sharedDir = join(root, 'shared');
    tenantStore = new TenantStore(join(root, 'tenants.json'));
    await tenantStore.ensureDefaultTenant();
    await tenantStore.create({ id: 'wain', name: '唯恩电气', createdBy: 'system' });
    await tenantStore.create({ id: 'kaiyan', name: '开沿科技', createdBy: 'system' });
    provider = new TenantCompanyInfoToolProvider({ sharedDir, tenantStore });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function context(user: UserIdentity): ToolCallContext {
    return {
      channelContext: { channel: 'web', user },
      workspace: { root: join(root, 'workspace'), executionTarget: 'server-local' },
      sessionId: 'session-1',
      runId: 'run-1',
    };
  }

  it('普通用户只能看到读取工具，组织 admin 可看到写工具', () => {
    expect(provider.list(context(WAIN_USER)).map((tool) => tool.id)).toEqual(['ReadCompanyInfo']);
    expect(provider.list(context(WAIN_ADMIN)).map((tool) => tool.id)).toEqual([
      'ReadCompanyInfo',
      'UpdateCompanyInfo',
    ]);
  });

  it('组织 admin 可更新并读取自己组织 company.md', async () => {
    await provider.invoke({
      toolId: 'UpdateCompanyInfo',
      input: { content: '# 唯恩电气\n组织资料' },
      authorization: { approved: true, source: 'human_approval' },
    }, context(WAIN_ADMIN));

    expect(readFileSync(join(sharedDir, 'tenants', 'wain', 'company.md'), 'utf-8')).toBe('# 唯恩电气\n组织资料');

    const result = await provider.invoke({
      toolId: 'ReadCompanyInfo',
      input: {},
      authorization: { approved: true, source: 'policy_auto' },
    }, context(WAIN_USER));
    expect(JSON.parse(result!.content)).toMatchObject({
      tenantId: 'wain',
      configured: true,
      content: '# 唯恩电气\n组织资料',
    });
  });

  it('组织 admin 不能更新其他组织 company.md', async () => {
    await expect(provider.invoke({
      toolId: 'UpdateCompanyInfo',
      input: { tenantId: 'kaiyan', content: '# 开沿科技' },
      authorization: { approved: true, source: 'human_approval' },
    }, context(WAIN_ADMIN))).rejects.toThrow(/跨组织访问 company\.md 被拒绝/);
  });

  it('平台 admin 可指定并更新任意组织 company.md', async () => {
    await provider.invoke({
      toolId: 'UpdateCompanyInfo',
      input: { tenantId: 'wain', content: '# Wain\nFrom platform admin' },
      authorization: { approved: true, source: 'human_approval' },
    }, context(PLATFORM_ADMIN));

    expect(readFileSync(join(sharedDir, 'tenants', 'wain', 'company.md'), 'utf-8')).toBe('# Wain\nFrom platform admin');
  });

  it('UpdateCompanyInfo 不接受 policy_auto，必须人工审批', async () => {
    await expect(provider.invoke({
      toolId: 'UpdateCompanyInfo',
      input: { content: '# 唯恩电气' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context(WAIN_ADMIN))).rejects.toThrow(/必须经过人工审批/);
  });

  it('平台 admin 开启自动批准时，策略仍要求 UpdateCompanyInfo 审批', async () => {
    const policy = new DefaultToolPolicy();
    const decision = await policy.decide(
      updateCompanyInfoToolDescriptor,
      { tenantId: 'wain', content: '# Wain' },
      {
        runId: 'run-1',
        sessionId: 'session-1',
        model: 'test',
        cwd: root,
        channelContext: { channel: 'web', user: PLATFORM_ADMIN },
        approvalPolicy: { autoApproveTools: true },
      } satisfies RunContext,
    );

    expect(decision.type).toBe('requires_approval');
  });
});
