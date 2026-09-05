/** 按窗口长度给出中文标签；两家供应商共用，避免各写一套。 */
export function quotaWindowLabel(windowSeconds: number | undefined): string {
  if (!windowSeconds || !Number.isFinite(windowSeconds)) return '额度窗口';
  if (windowSeconds === 18_000) return '5 小时';
  if (windowSeconds === 86_400) return '近一天';
  if (windowSeconds === 604_800) return '每周';
  if (windowSeconds >= 2_419_200) return '每月';
  if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600} 小时`;
  return `${Math.round(windowSeconds / 60)} 分钟`;
}

export function epochMsToIso(value: unknown): string | undefined {
  const ms = typeof value === 'string' ? Number(value) : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export function epochSecondsToIso(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : value;
  return typeof num === 'number' && Number.isFinite(num) ? num : undefined;
}
