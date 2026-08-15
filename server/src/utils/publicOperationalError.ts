import { randomUUID } from 'node:crypto';

const INTERNAL_OPERATIONAL_ERROR_CODES = new Set([
  'INTERNAL_OPERATION_FAILED',
  'CRON_OPERATION_FAILED',
  'CRON_RUN_DETAILS_FAILED',
  'CRON_RUN_FAILED',
  'CRON_RUN_REJECTED',
  'CRON_TRANSCRIPT_ACCESS_DENIED',
  'RUNTIME_EFFICIENCY_QUERY_FAILED',
  'RUNTIME_RECENT_RUNS_QUERY_FAILED',
  'RUNTIME_RUN_FAILED',
  'RUNTIME_TRACE_QUERY_FAILED',
]);

export interface OperationalErrorLogger {
  error(message: string): void;
}

function rawErrorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}:${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function internalCode(fallbackCode: string): string {
  return INTERNAL_OPERATIONAL_ERROR_CODES.has(fallbackCode)
    ? fallbackCode
    : 'INTERNAL_OPERATION_FAILED';
}

/**
 * 对非平台调用方返回稳定、不含运行环境细节的错误信息。
 * code 只来自服务端调用点白名单；diagnosticId 每次由服务端生成，并可同步写入关联日志。
 * 输入对象上的 code / errorCode / diagnosticId 一律视为不可信数据。
 */
export function publicOperationalError(
  value: unknown,
  fallbackCode: string,
  publicMessage = '服务暂不可用，请稍后重试',
  logger?: OperationalErrorLogger,
  logContext?: string,
): { error: string; code: string; diagnosticId: string } {
  const code = internalCode(fallbackCode);
  const diagnosticId = `diag_${randomUUID().replaceAll('-', '')}`;
  logger?.error(
    `[${diagnosticId}] ${code}${logContext ? ` ${logContext}` : ''}: ${rawErrorText(value)}`,
  );
  return { error: publicMessage, code, diagnosticId };
}

export function publicOperationalErrorMessage(
  value: unknown,
  fallbackCode: string,
  publicMessage = '执行失败（详细错误已隐藏）',
  logger?: OperationalErrorLogger,
  logContext?: string,
): { message: string; code: string; diagnosticId: string } {
  const sanitized = publicOperationalError(
    value,
    fallbackCode,
    publicMessage,
    logger,
    logContext,
  );
  return { message: sanitized.error, code: sanitized.code, diagnosticId: sanitized.diagnosticId };
}
