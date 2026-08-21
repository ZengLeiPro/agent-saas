const CODEX_QUOTA_PATTERN = /(?:insufficient[_ -]?quota|quota[_ -]?(?:exceeded|exhausted|reached|depleted)|(?:usage|plan|monthly|weekly)[_ -]?limit[_ -]?(?:exceeded|exhausted|reached)|billing[_ -]?hard[_ -]?limit[_ -]?(?:exceeded|reached)|(?:exceeded|reached|exhausted|depleted).{0,40}(?:quota|usage limit|plan limit)|(?:quota|usage|plan limit).{0,40}(?:exceeded|reached|exhausted|depleted))/i;

export function isCodexQuotaError(input: {
  status?: number;
  code?: string;
  message?: string;
  rawText?: string;
}): boolean {
  if (input.status === 402) return true;
  return CODEX_QUOTA_PATTERN.test([
    input.code ?? '',
    input.message ?? '',
    input.rawText ?? '',
  ].join(' '));
}

export function quotaErrorCode(input: { code?: string; message?: string; rawText?: string }): string {
  const value = `${input.code ?? ''} ${input.message ?? ''} ${input.rawText ?? ''}`.toLowerCase();
  if (value.includes('insufficient_quota')) return 'insufficient_quota';
  if (value.includes('quota')) return 'quota_exhausted';
  return 'usage_limit_reached';
}
