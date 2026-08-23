import type { SubagentOutcome } from './subagentRunner.js';

export function formatSubagentFailureHeader(outcome: SubagentOutcome, meta: string): string {
  if (outcome.failureKind === 'policy_rejection') {
    return `[子 agent 策略拒绝] recovery=${outcome.recoveryAction ?? 'switch_model'}｜${outcome.errorMessage ?? '当前模型受策略限制'}｜${meta}`;
  }
  return `[子 agent 异常终止] status=${outcome.status}｜${outcome.errorMessage ?? '未知错误'}｜${meta}`;
}
