import type { ChannelContext, ModelOutputTransactionMode } from '../types/index.js';

export const DEFAULT_MODEL_OUTPUT_TRANSACTION_MODE: ModelOutputTransactionMode = 'irreversible_stream';

export function isModelOutputTransactionMode(value: unknown): value is ModelOutputTransactionMode {
  return value === 'replaceable_draft'
    || value === 'terminal_buffered'
    || value === 'irreversible_stream';
}

/**
 * Runtime 输出事务语义的唯一解析边界。
 * 新 Run 只持久化 outputTransactionMode；replaceableDrafts 仅用于恢复旧 Run。
 */
export function resolveModelOutputTransactionMode(
  source: Pick<ChannelContext, 'outputTransactionMode' | 'replaceableDrafts'> | Record<string, unknown> | undefined,
): ModelOutputTransactionMode {
  if (isModelOutputTransactionMode(source?.outputTransactionMode)) {
    return source.outputTransactionMode;
  }
  if (source?.replaceableDrafts === true) return 'replaceable_draft';
  return DEFAULT_MODEL_OUTPUT_TRANSACTION_MODE;
}

export function supportsReplaceableDrafts(
  source: Pick<ChannelContext, 'outputTransactionMode' | 'replaceableDrafts'> | Record<string, unknown> | undefined,
): boolean {
  return resolveModelOutputTransactionMode(source) === 'replaceable_draft';
}
