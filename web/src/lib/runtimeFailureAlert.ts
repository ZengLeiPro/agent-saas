import { formatRuntimeFailureMessage, isInsufficientCreditsFailure } from '@agent/shared';
import type { RuntimeFailureKind } from '@agent/shared';
import type { TerminalRuntimeStatus } from '@/hooks/chatRuntimeHelpers';

export type RuntimeAlertSeverity = 'error' | 'cancelled' | 'billing';

export interface RuntimeTerminalAlert {
  /** null = 该终态不需要给客户任何提示（如正常完成） */
  content: string | null;
  severity: RuntimeAlertSeverity;
}

/**
 * run 终态 → 客户面提示（文案 + 严重级）。
 *
 * 从 useChatAppState.finalizeTerminalRuntime 抽出的纯函数：
 * 文案由 shared 的 formatRuntimeFailureMessage 统一渲染（含配额重置时刻）。
 */
export function runtimeTerminalAlert(input: {
  status: TerminalRuntimeStatus;
  reason?: string;
  failureKind?: RuntimeFailureKind;
  /** 仅配额型失败：绝对重置时刻（ISO），交给文案层渲染成「额度将在 HH:mm 重置」 */
  quotaResetAt?: string;
}): RuntimeTerminalAlert {
  if (input.status === 'failed' || input.status === 'orphaned') {
    return {
      content: formatRuntimeFailureMessage(input.reason, input.failureKind, input.quotaResetAt),
      severity: isInsufficientCreditsFailure(input.reason) ? 'billing' : 'error',
    };
  }
  if (input.status === 'cancelled') return { content: '会话已停止', severity: 'cancelled' };
  return { content: null, severity: 'error' };
}
