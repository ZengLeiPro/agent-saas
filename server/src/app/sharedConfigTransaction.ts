export interface SharedConfigCommitStep {
  label: string;
  commit: () => void;
  rollback: () => void;
}

export interface SharedConfigCommitFailure {
  error: unknown;
  rollbackErrors: Array<{ label: string; error: unknown }>;
}

/**
 * 提交准备完成的共享配置事务，并且只在候选仍是磁盘最新版时发布。
 * commit 抛错或 post-check 失败时，从最后一个已尝试步骤开始逆序回滚；
 * 单个 rollback 失败不会阻止其余步骤恢复。
 */
export function finalizeSharedConfigTransaction(params: {
  steps: SharedConfigCommitStep[];
  isCandidateCurrent: () => boolean;
  publish: () => void;
  onFailure: (failure: SharedConfigCommitFailure) => void;
}): boolean {
  let attemptedStep = -1;
  try {
    for (let index = 0; index < params.steps.length; index += 1) {
      attemptedStep = index;
      params.steps[index]!.commit();
    }
    if (!params.isCandidateCurrent()) {
      throw new Error('config.json 在候选 commit 期间被并发覆盖');
    }
  } catch (error) {
    const rollbackErrors: SharedConfigCommitFailure['rollbackErrors'] = [];
    for (let index = attemptedStep; index >= 0; index -= 1) {
      const step = params.steps[index]!;
      try {
        step.rollback();
      } catch (rollbackError) {
        rollbackErrors.push({ label: step.label, error: rollbackError });
      }
    }
    params.onFailure({ error, rollbackErrors });
    return false;
  }

  params.publish();
  return true;
}
