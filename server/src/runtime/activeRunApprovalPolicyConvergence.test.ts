import { describe, expect, it, vi } from 'vitest';

import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { UserStore } from '../data/users/store.js';
import {
  ActiveRunApprovalPolicyConvergenceError,
  savePreferencesWithApprovalConvergence,
} from './accountApprovalPreferenceService.js';
import { PgRunStoreQueries } from './runStoreQueries.js';
import { DefaultToolPolicy } from './toolPolicy.js';
import {
  accountApprovalPolicyMetadata,
  convergeActiveRunApprovalPolicies,
} from './activeRunApprovalPolicyConvergence.js';
import type { RunContext } from './types.js';

const dangerousTool = {
  id: 'DangerousWithoutNeverAutoApprove', name: 'DangerousWithoutNeverAutoApprove',
  displayName: '测试危险工具', description: '测试', schema: {}, risk: 'dangerous',
} as unknown as ToolDescriptor;
const writeTool = { ...dangerousTool, id: 'WriteTool', name: 'WriteTool', risk: 'workspace_write' } as ToolDescriptor;

function policyContext(approvalPolicy: Record<string, unknown> | null): RunContext {
  return {
    runId: 'run', sessionId: 'session', model: 'model', cwd: '/tmp',
    channelContext: { channel: 'web', user: { id: 'user-1', username: 'u1' } },
    ...(approvalPolicy ? { approvalPolicy } : {}),
  } as unknown as RunContext;
}

function twoActiveRunsStore() {
  const policies = new Map<string, Record<string, unknown> | null>([
    ['run-a', { autoApproveTools: true }],
    ['run-b', { autoApproveTools: true }],
  ]);
  return {
    policies,
    updateApprovalPolicyForActiveByUser: vi.fn(async (_userId: string, policy: Record<string, unknown> | null) => {
      for (const runId of policies.keys()) policies.set(runId, policy);
      return [...policies.keys()];
    }),
  };
}

function preferenceStore(initial = { authorizationModeEnabled: true, lowRiskToolsAutoApproveEnabled: false }) {
  let preferences = { ...initial };
  return {
    store: {
      findById: () => ({ preferences }),
      updatePreferences: vi.fn(async (_userId: string, patch: Record<string, unknown>) => {
        preferences = { ...preferences, ...patch } as typeof preferences;
        return { preferences };
      }),
    } as unknown as UserStore,
    get preferences() { return preferences; },
  };
}

/** TASK-256：账户降档必须权威收敛所有 active run，而非只更新当前 Web 会话。 */
describe('账户批准档位的活跃 run 收敛', () => {
  it('缺省/full、low-risk、ask 偏好解析与前后端三档语义一致', () => {
    expect(accountApprovalPolicyMetadata(undefined)).toEqual({ autoApproveTools: true });
    expect(accountApprovalPolicyMetadata({ authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: true }))
      .toEqual({ autoApproveTools: true, lowRiskOnly: true });
    expect(accountApprovalPolicyMetadata({ authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: false }))
      .toBeNull();
  });

  it('full->ask 原子更新两个 active run；下一次 dangerous 裁决均需人工批准', async () => {
    const store = twoActiveRunsStore();
    const result = await convergeActiveRunApprovalPolicies(store, 'user-1', {
      authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: false,
    });
    expect(result.updatedRunIds).toEqual(['run-a', 'run-b']);
    expect(store.updateApprovalPolicyForActiveByUser).toHaveBeenCalledTimes(1);
    for (const policy of store.policies.values()) {
      expect(policy).toBeNull();
      await expect(new DefaultToolPolicy().decide(dangerousTool, {}, policyContext(policy)))
        .resolves.toMatchObject({ type: 'requires_approval' });
    }
  });

  it('full->low-risk 原子更新两个 active run；write 自动通过、dangerous 均需人工批准', async () => {
    const store = twoActiveRunsStore();
    await convergeActiveRunApprovalPolicies(store, 'user-1', {
      authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: true,
    });
    for (const policy of store.policies.values()) {
      expect(policy).toEqual({ autoApproveTools: true, lowRiskOnly: true });
      await expect(new DefaultToolPolicy().decide(writeTool, {}, policyContext(policy)))
        .resolves.toMatchObject({ type: 'allow' });
      await expect(new DefaultToolPolicy().decide(dangerousTool, {}, policyContext(policy)))
        .resolves.toMatchObject({ type: 'requires_approval' });
    }
  });

  it('PgRunStore 使用单条 UPDATE 原子更新全部活跃 run（含低风险 JSON metadata）', async () => {
    const query = vi.fn(async () => ({ rows: [{ run_id: 'run-a' }, { run_id: 'run-b' }] }));
    const queries = new PgRunStoreQueries({ query } as never, 'runtime_runs', 'submissions', 'steering');
    await expect(queries.updateApprovalPolicyForActiveByUser(
      'user-1', { autoApproveTools: true, lowRiskOnly: true },
    )).resolves.toEqual(['run-a', 'run-b']);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('UPDATE runtime_runs');
    expect(sql).toContain("status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')");
    expect(params).toEqual(['user-1', '{"autoApproveTools":true,"lowRiskOnly":true}']);
  });

  it('偏好保存仅在全部 active run 收敛成功后返回成功和更新数', async () => {
    const users = preferenceStore();
    const runs = twoActiveRunsStore();
    await expect(savePreferencesWithApprovalConvergence({
      userStore: users.store, runStore: runs, userId: 'user-1',
      preferences: { authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: true },
    })).resolves.toMatchObject({
      preferences: { authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: true },
      activeRunsPolicyUpdated: 2,
    });
  });

  it('收敛失败回滚账户档位并抛出专用错误，UI 不会显示已保存即生效', async () => {
    const users = preferenceStore();
    const updateApprovalPolicyForActiveByUser = vi.fn(async () => { throw new Error('pg unavailable'); });
    await expect(savePreferencesWithApprovalConvergence({
      userStore: users.store, runStore: { updateApprovalPolicyForActiveByUser }, userId: 'user-1',
      preferences: { authorizationModeEnabled: false, lowRiskToolsAutoApproveEnabled: false },
    })).rejects.toBeInstanceOf(ActiveRunApprovalPolicyConvergenceError);
    expect(users.preferences).toEqual({ authorizationModeEnabled: true, lowRiskToolsAutoApproveEnabled: false });
  });
});
