import type { UserStore } from '../data/users/store.js';
import type { UserPreferences } from '../data/users/types.js';
import type { RunStore } from './runStoreTypes.js';
import { convergeActiveRunApprovalPolicies } from './activeRunApprovalPolicyConvergence.js';

export class ActiveRunApprovalPolicyConvergenceError extends Error {
  constructor(cause: unknown) {
    super('账户偏好已回滚：活跃运行批准策略未能同步，请重试', { cause });
    this.name = 'ActiveRunApprovalPolicyConvergenceError';
  }
}

/**
 * 保存个人偏好；批准档位字段变化时同时原子收敛该用户所有 active run。
 * 收敛失败会把账户档位恢复为保存前语义，并抛出可映射为 HTTP 503 的错误；调用方
 * 不得将其展示为成功。其他界面偏好不触发 runStore。
 */
export async function savePreferencesWithApprovalConvergence(options: {
  userStore: UserStore;
  runStore?: Pick<RunStore, 'updateApprovalPolicyForActiveByUser'>;
  userId: string;
  preferences: UserPreferences;
}): Promise<{ preferences: UserPreferences; activeRunsPolicyUpdated?: number }> {
  const { userStore, runStore, userId, preferences } = options;
  const before = userStore.findById(userId)?.preferences;
  const updated = await userStore.updatePreferences(userId, preferences);
  const approvalTierChanged = preferences.authorizationModeEnabled !== undefined
    || preferences.lowRiskToolsAutoApproveEnabled !== undefined;
  if (!approvalTierChanged) return { preferences: updated.preferences ?? {} };

  try {
    const converged = await convergeActiveRunApprovalPolicies(runStore, userId, updated.preferences);
    return {
      preferences: updated.preferences ?? {},
      activeRunsPolicyUpdated: converged.updatedRunIds.length,
    };
  } catch (cause) {
    const rolledBack = await userStore.updatePreferences(userId, {
      authorizationModeEnabled: before?.authorizationModeEnabled ?? true,
      lowRiskToolsAutoApproveEnabled: before?.lowRiskToolsAutoApproveEnabled === true,
    });
    try {
      await convergeActiveRunApprovalPolicies(runStore, userId, rolledBack.preferences);
    } catch {
      // 原始收敛是单条 SQL，失败时没有部分更新；恢复失败不会扩大权限。
    }
    throw new ActiveRunApprovalPolicyConvergenceError(cause);
  }
}
