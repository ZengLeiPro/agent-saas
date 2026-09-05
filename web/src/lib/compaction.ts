/**
 * 上下文压缩黑箱化（2026-07）—— 实现已下沉到 `@agent/shared`（PR #476 strangler 首例）。
 *
 * 本文件只做 re-export，保留 `@/lib/compaction` 这个既有导入路径，
 * 实现（服务端契约说明、as-cast 桥接理由）见 shared/src/lib/compaction.ts。
 *
 * 注意：shared 的 `CompactionMessageItem.status` 为可选（兼容 mobile 会话重载路径
 * 历史上不写该字段的产物），web 侧只做 `=== 'running'` 判定，语义不变。
 */
export {
  asCompactionItem,
  createCompactionRunningItem,
  createCompactionDoneItem,
  compactionDoneReplacement,
  compactionItemFromBlock,
} from '@agent/shared';
export type {
  CompactionMessageItem,
  CompactionOutcome,
  CompactionStatusEvent,
} from '@agent/shared';
