import type { CanonicalError } from './canonicalError';
import type { SharedPresentation, SharedPresentationRecoveryAction } from './presentationPresenter';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../types/runtimeFailure';

/**
 * 客户面失败文案的唯一口径。
 *
 * 纪律（2026-09 产品拍板）：
 * 1. 普通/未知失败只说「Agent 开小差了，请发送「继续」」——用户能做的只有这一件事；
 * 2. 结构化策略拒绝（cyber_policy 之类，服务端已归类为 policy_rejection /
 *    recoveryAction=switch_model）绝不能提示「继续」，同一个模型再来一次仍会被拒；
 * 3. 配额型 429（shared canonical 已解析为 rate_limited）显示重置时间与「切换模型」入口。
 *
 * 分类只读**已归类的结构化字段**（severity / failureKind / recoveryAction /
 * canonicalFailure.kind），绝不从错误文本里猜——错误文本既不稳定也不安全。
 */
export type ClientFailureKind =
  'cancelled' | 'policy' | 'quota' | 'billing' | 'canonical' | 'generic';

export interface ClientFailureCopy {
  kind: ClientFailureKind;
  title: string;
  /** 面向客户的主文案。 */
  message: string;
  /** 补充说明（当前只有配额重置时间）。 */
  hint?: string;
  /** 至多一个恢复动作。 */
  action?: SharedPresentationRecoveryAction;
}

export interface ClientFailureCopyInput {
  /** shared `selectErrorPresentation` 的产物。 */
  presentation: Pick<
    SharedPresentation,
    'title' | 'status' | 'statusLabel' | 'summary' | 'recoveryAction'
  >;
  severity?: 'error' | 'cancelled' | 'billing';
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
  canonicalFailure?: CanonicalError;
}

export const GENERIC_FAILURE_MESSAGE = 'Agent 开小差了，请发送「继续」';
export const POLICY_FAILURE_MESSAGE = '当前模型无法完成，建议切换模型后重试';

const SWITCH_MODEL_ACTION: SharedPresentationRecoveryAction = {
  kind: 'switch_model',
  label: '切换模型',
};

/** 相对重置时间：与时区/本地化无关，跨端一致且可单测。 */
export function formatQuotaResetHint(retryAfterMs: number | undefined): string | undefined {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0)
    return undefined;
  if (retryAfterMs < 60_000) return `额度将在 ${Math.ceil(retryAfterMs / 1_000)} 秒后重置`;
  if (retryAfterMs < 3_600_000) return `额度将在 ${Math.ceil(retryAfterMs / 60_000)} 分钟后重置`;
  return `额度将在 ${Math.ceil(retryAfterMs / 3_600_000)} 小时后重置`;
}

function isPolicyRejection(input: ClientFailureCopyInput): boolean {
  return (
    input.failureKind === 'policy_rejection' ||
    input.recoveryAction === 'switch_model' ||
    input.presentation.recoveryAction?.kind === 'switch_model'
  );
}

export function selectClientFailureCopy(input: ClientFailureCopyInput): ClientFailureCopy {
  const { presentation } = input;

  if (presentation.status === 'cancelled' || input.severity === 'cancelled') {
    return {
      kind: 'cancelled',
      title: presentation.title,
      message: presentation.summary ?? '本次运行已取消。',
    };
  }

  if (isPolicyRejection(input)) {
    return {
      kind: 'policy',
      title: presentation.title,
      message: POLICY_FAILURE_MESSAGE,
      action: SWITCH_MODEL_ACTION,
    };
  }

  if (input.canonicalFailure?.kind === 'rate_limited') {
    const hint = formatQuotaResetHint(input.canonicalFailure.retryAfterMs);
    return {
      kind: 'quota',
      title: input.canonicalFailure.title,
      message: input.canonicalFailure.safeMessage,
      ...(hint ? { hint } : {}),
      action: SWITCH_MODEL_ACTION,
    };
  }

  if (input.severity === 'billing') {
    return {
      kind: 'billing',
      title: presentation.title,
      message: presentation.summary ?? '当前组织积分余额不足，请补充积分后重试。',
      action: presentation.recoveryAction ?? { kind: 'view_billing', label: '查看积分' },
    };
  }

  // canonical 失败自带客户面安全文案与唯一恢复动作，直接消费；unknown 例外，走通用口径。
  const canonical = input.canonicalFailure;
  if (canonical && canonical.kind !== 'unknown') {
    return {
      kind: 'canonical',
      title: canonical.title,
      message: canonical.safeMessage,
      ...(canonical.recoveryAction.kind !== 'none' ? { action: canonical.recoveryAction } : {}),
    };
  }

  return {
    kind: 'generic',
    title: presentation.title,
    message: GENERIC_FAILURE_MESSAGE,
    ...(presentation.recoveryAction?.kind === 'retry'
      ? { action: presentation.recoveryAction }
      : {}),
  };
}
