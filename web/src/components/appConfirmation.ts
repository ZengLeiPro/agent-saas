import type { WsToolConfirmationCard } from '@agent/shared';

/** 与服务端 `APP_CONFIRM_WORD` 保持一致。 */
export const DEFAULT_CONFIRM_WORD = '确认';

const MAX_SUMMARY_ROWS = 6;
const MAX_SUMMARY_VALUE_LENGTH = 60;

export function isAppCapabilityToolName(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && toolName.startsWith('app__');
}

function summarizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_SUMMARY_VALUE_LENGTH
      ? `${trimmed.slice(0, MAX_SUMMARY_VALUE_LENGTH)}…`
      : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `共 ${value.length} 项`;
  return null;
}

/** 服务端没给卡片时的兜底推导。与服务端 `buildAppConfirmationCard` 同一套规则。 */
export function deriveConfirmationCard(
  toolName: string,
  toolInput: string,
): WsToolConfirmationCard {
  const segments = toolName.slice('app__'.length).split('__');
  let params: Array<{ label: string; value: string }> = [];
  try {
    const parsed: unknown = JSON.parse(toolInput);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = Object.entries(parsed as Record<string, unknown>)
        .map(([label, raw]) => ({ label, value: summarizeValue(raw) }))
        .filter((row): row is { label: string; value: string } => row.value !== null)
        .slice(0, MAX_SUMMARY_ROWS);
    }
  } catch {
    params = [];
  }
  return {
    systemName: segments[0] ?? toolName,
    capabilityName: segments.slice(1).join('__') || toolName,
    params,
    irreversible: true,
    confirmWord: DEFAULT_CONFIRM_WORD,
  };
}
