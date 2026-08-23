export const COMPACTION_SUMMARY_SCHEMA_VERSION = 1;

export const REQUIRED_COMPACTION_SUMMARY_SECTIONS = [
  '当前任务与约束',
  '已完成工作',
  '外部副作用与回执',
  '当前代码/文件/测试状态',
  '未完成事项',
  '下一步动作',
  '历史检索引用',
] as const;

export interface CompactionSummaryValidation {
  schemaVersion: typeof COMPACTION_SUMMARY_SCHEMA_VERSION;
  valid: boolean;
  presentSectionCount: number;
  missingSections: string[];
  maintenanceInstructionAttributedToUser: boolean;
}

/**
 * 压缩结果的轻量结构校验。自定义 prompt 仍可输出其它格式，因此校验结果只入审计，
 * 不阻断 checkpoint；默认 prompt 的缺节或维护指令误归因会留下明确观测信号。
 */
export function validateCompactionSummary(summary: string): CompactionSummaryValidation {
  const missingSections = REQUIRED_COMPACTION_SUMMARY_SECTIONS.filter((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^#{1,6}\\s*${escaped}\\s*$`, 'mu').test(summary);
  });
  const opening = summary.slice(0, 500);
  const maintenanceInstructionAttributedToUser = /用户.{0,8}(?:要求|请求).{0,8}(?:暂停|停止|中断)(?:任务|工作)?/u.test(opening);
  return {
    schemaVersion: COMPACTION_SUMMARY_SCHEMA_VERSION,
    valid: missingSections.length === 0 && !maintenanceInstructionAttributedToUser,
    presentSectionCount: REQUIRED_COMPACTION_SUMMARY_SECTIONS.length - missingSections.length,
    missingSections: [...missingSections],
    maintenanceInstructionAttributedToUser,
  };
}
