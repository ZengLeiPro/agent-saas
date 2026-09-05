/**
 * 运行时失败的结构化载体类型。
 *
 * 从 runtime/types.ts 抽出；types.ts 原样转发，外部继续从 './types.js' 引用。
 */
import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../types/index.js';

/** 发流前 provider 失败的结构化错误；避免在 adapter 边界退化成不可审计字符串。 */
export class ModelProviderError extends Error {
  readonly name = 'ModelProviderError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly modelRequestId: string,
    readonly attemptId: string,
    readonly emittedOutputCount: number,
    readonly failureKind?: RuntimeFailureKind,
    readonly recoveryAction?: RuntimeRecoveryAction,
    readonly partialContent?: string,
    /** 仅 failureKind='quota_exhausted'：上游结构化字段给出的配额重置时刻（ISO） */
    readonly quotaResetAt?: string,
  ) {
    super(message);
  }
}
