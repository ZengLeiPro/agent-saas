/**
 * 附件存储用量投影 —— 与 Web `SettingsCenter/AttachmentStorageSection.tsx` 同源。
 *
 * 契约（服务端权威，不臆造）：
 *   - `GET    /api/uploads/usage`   读取用量
 *   - `DELETE /api/uploads/staged`  清理未发送附件
 *   - `DELETE /api/uploads/all`     清空全部附件
 *
 * 本模块只做纯投影（用量卡片、按钮文案、二次确认文案），
 * 网络与浮层留在屏幕组件里。
 */
import { formatFileSize } from '@agent/shared';

/** 与 Web `AttachmentUsage` 逐字段一致。 */
export interface AttachmentUsage {
  totalBytes: number;
  totalFiles: number;
  stagedBytes: number;
  stagedFiles: number;
  referencedBytes: number;
  referencedFiles: number;
  legacyBytes: number;
  legacyFiles: number;
  partialBytes: number;
  partialFiles: number;
  stagedRetentionHours: number;
  measuredAt: string;
}

export interface AttachmentUsageRow {
  key: 'total' | 'referenced' | 'staged' | 'legacy';
  label: string;
  /** 右侧值：已格式化的容量 */
  value: string;
  /** 副标题：文件数 + 清理口径 */
  hint: string;
}

/** 与 Web 的四张 UsageCard 同名同序。 */
export function attachmentUsageRows(usage: AttachmentUsage): AttachmentUsageRow[] {
  return [
    {
      key: 'total',
      label: '附件总量',
      value: formatFileSize(usage.totalBytes),
      hint: `${usage.totalFiles} 个文件 · 当前工作区`,
    },
    {
      key: 'referenced',
      label: '已发送',
      value: formatFileSize(usage.referencedBytes),
      hint: `${usage.referencedFiles} 个文件 · 不自动清理`,
    },
    {
      key: 'staged',
      label: '未发送',
      value: formatFileSize(usage.stagedBytes),
      hint: `${usage.stagedFiles} 个文件 · ${usage.stagedRetentionHours} 小时后自动清理`,
    },
    {
      key: 'legacy',
      label: '其他/历史',
      value: formatFileSize(usage.legacyBytes),
      hint: `${usage.legacyFiles} 个文件 · 不参与自动清理`,
    },
  ];
}

/** 传输中/异常中断的临时文件提示；无此类文件时返回 null。 */
export function attachmentPartialNotice(usage: AttachmentUsage): string | null {
  if (usage.partialFiles <= 0) return null;
  return `另有 ${usage.partialFiles} 个传输中或异常中断的临时文件，共 ${formatFileSize(usage.partialBytes)}；超龄临时文件会自动清理。`;
}

export interface AttachmentCleanupAction {
  /** 行标题右侧的动作文案 */
  actionLabel: string;
  disabled: boolean;
  /** 二次确认文案（与 Web window.confirm 同口径） */
  confirmTitle: string;
  confirmMessage: string;
}

/** 「清理未发送附件」的按钮与确认文案。 */
export function stagedCleanupAction(usage: AttachmentUsage | null): AttachmentCleanupAction {
  const files = usage?.stagedFiles ?? 0;
  return {
    actionLabel: files > 0 ? `清理 ${files} 个` : '无需清理',
    disabled: files === 0,
    confirmTitle: '清理未发送附件',
    confirmMessage: `将删除 ${files} 个尚未发送的附件（${formatFileSize(usage?.stagedBytes ?? 0)}）。已发送附件和历史文件不会删除，是否继续？`,
  };
}

/** 「清空全部附件」的按钮与确认文案。 */
export function purgeAllAction(usage: AttachmentUsage | null): AttachmentCleanupAction {
  const files = usage?.totalFiles ?? 0;
  return {
    actionLabel: files > 0 ? `清空 ${files} 个` : '已无附件',
    disabled: files === 0,
    confirmTitle: '清空全部附件',
    confirmMessage: `将永久删除全部 ${files} 个附件（${formatFileSize(usage?.totalBytes ?? 0)}），其中包含 ${usage?.referencedFiles ?? 0} 个已发送附件。\n历史会话里的这些附件将无法再预览或下载，删除后不可恢复。确定继续？`,
  };
}
