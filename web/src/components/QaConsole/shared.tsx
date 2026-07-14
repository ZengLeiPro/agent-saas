import { Database } from 'lucide-react';

/** 数据面不可用（file backend 未装配 PG）：503 → 隐藏功能换提示 */
export function QaUnavailableHint() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-muted-foreground">
      <Database className="size-6" />
      <div className="text-sm">对话质检需要 PG 数据面支持，当前部署未启用。</div>
    </div>
  );
}

export function formatQaTime(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
