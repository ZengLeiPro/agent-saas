/**
 * SDK 0.2.112+ 新系统事件的统一渲染层：
 * - NotificationToast：REPL 级通知（immediate/high/medium/low 色彩 + timeoutMs 自动消失）
 * - MemoryRecallBanner：supervisor 召回的记忆元数据
 * - PluginInstallBanner：插件安装进度（started → installed/failed → completed）
 */

import { X } from "lucide-react";
import type { NotificationData, MemoryRecallData, PluginInstallData } from "@agent/shared";

const PRIORITY_STYLE: Record<NotificationData['priority'], string> = {
  immediate: 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-800 dark:text-red-100',
  high: 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-100',
  medium: 'bg-blue-50 border-blue-300 text-blue-900 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-100',
  low: 'bg-muted border-border text-muted-foreground',
};

export function NotificationToastStack({
  notifications,
  onDismiss,
}: {
  notifications: NotificationData[];
  onDismiss: (key: string) => void;
}) {
  if (notifications.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2">
      {notifications.map((n) => (
        <div
          key={n.key}
          className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-md ${PRIORITY_STYLE[n.priority]}`}
          style={n.color ? { borderColor: n.color } : undefined}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="whitespace-pre-wrap break-words">{n.text}</div>
            <button
              type="button"
              className="shrink-0 opacity-60 hover:opacity-100"
              onClick={() => onDismiss(n.key)}
              aria-label="关闭通知"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function MemoryRecallBanner({
  data,
  onDismiss,
}: {
  data: MemoryRecallData | null;
  onDismiss: () => void;
}) {
  if (!data || data.memories.length === 0) return null;
  return (
    <div className="mx-2 my-2 rounded-md border border-border bg-muted/50 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-muted-foreground">
          从记忆中召回 {data.memories.length} 条
          {data.mode === 'synthesize' ? '（已合成）' : ''}
        </span>
        <button
          type="button"
          className="opacity-60 hover:opacity-100"
          onClick={onDismiss}
          aria-label="隐藏记忆召回"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <details>
        <summary className="cursor-pointer text-muted-foreground">查看记忆路径</summary>
        <ul className="mt-1 space-y-0.5 pl-4">
          {data.memories.map((m) => (
            <li key={m.path} className="font-mono text-[11px] text-muted-foreground">
              <span className="mr-1 text-[10px] opacity-60">[{m.scope}]</span>
              {m.path}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const PLUGIN_STATUS_LABEL: Record<PluginInstallData['status'], string> = {
  started: '开始安装',
  installed: '安装成功',
  failed: '安装失败',
  completed: '安装完成',
};

export function PluginInstallBanner({ data }: { data: PluginInstallData | null }) {
  if (!data) return null;
  const isError = data.status === 'failed';
  const isDone = data.status === 'installed' || data.status === 'completed';
  const color = isError ? 'text-red-700 dark:text-red-300'
    : isDone ? 'text-green-700 dark:text-green-300'
    : 'text-blue-700 dark:text-blue-300';
  return (
    <div className="mx-2 my-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
      <span className={color}>{PLUGIN_STATUS_LABEL[data.status]}</span>
      {data.name && <span className="ml-2 font-mono">{data.name}</span>}
      {data.errorMessage && <span className="ml-2 text-muted-foreground">{data.errorMessage}</span>}
    </div>
  );
}
