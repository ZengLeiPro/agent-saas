/**
 * /compact v2 黑箱压缩 —— 薄转发层。
 *
 * 实现已上收到 `@agent/shared` 的 `lib/compaction.ts` 超集（strangler 首例）：
 * 同一份契约同时导出 mobile 口径（isCompactionItem / isCompactionStatusEvent /
 * injectCompactionMessages）与 web 口径（asCompactionItem / create*Item /
 * compactionDoneReplacement / compactionItemFromBlock）。
 * 本文件只保留导入路径，禁止在这里新增本地逻辑。
 */
export {
  asCompactionItem,
  isCompactionItem,
  isCompactionStatusEvent,
  createCompactionRunningItem,
  createCompactionDoneItem,
  compactionDoneReplacement,
  compactionItemFromBlock,
  injectCompactionMessages,
} from "@agent/shared";
export type {
  CompactionMessageItem,
  CompactionOutcome,
  CompactionStatusEvent,
} from "@agent/shared";
