import type { UserStore } from '../data/users/store.js';

export type ApprovalIdentity = { userId?: string; username?: string };

/**
 * 账户级授权偏好 resolver 工厂（TASK-256 自 app/runtime.ts 抽出）。
 * userStore 缺失或用户不存在时返回 undefined，保持 dispatch 的 fail-closed 语义。
 */
export function createApprovalPreferenceResolvers(userStore: UserStore | undefined) {
  const findUser = ({ userId, username }: ApprovalIdentity) => (userId
    ? userStore?.findById(userId)
    : username
      ? userStore?.findByUsername(username)
      : undefined);
  return {
    // 「全部授权」是账户级服务端策略，不能依赖 Web 客户端逐条消息透传。
    // 老用户没有该字段时与前端默认值保持一致：默认开启；用户不存在则 fail-closed。
    resolveUserAutoApproveTools: (identity: ApprovalIdentity) => {
      const user = findUser(identity);
      if (!user) return undefined;
      return user.preferences?.authorizationModeEnabled ?? true;
    },
    // 「低风险常开」个人档（TASK-256）：仅在「全部授权」关闭时生效。
    // 自动批准 safe + workspace_write，dangerous 仍人工批准。
    resolveUserLowRiskAutoApprove: (identity: ApprovalIdentity) =>
      findUser(identity)?.preferences?.lowRiskToolsAutoApproveEnabled === true,
  };
}
