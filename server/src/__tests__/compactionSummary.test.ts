import { describe, expect, it } from 'vitest';

import {
  REQUIRED_COMPACTION_SUMMARY_SECTIONS,
  validateCompactionSummary,
} from '../runtime/compactionSummary.js';

describe('compaction summary validation', () => {
  it('固定七节完整时通过', () => {
    const summary = REQUIRED_COMPACTION_SUMMARY_SECTIONS
      .map((section) => `## ${section}\n无`)
      .join('\n\n');

    expect(validateCompactionSummary(summary)).toEqual({
      schemaVersion: 1,
      valid: true,
      presentSectionCount: 7,
      missingSections: [],
      maintenanceInstructionAttributedToUser: false,
    });
  });

  it('缺节与“用户要求暂停任务”误归因进入审计结果', () => {
    const result = validateCompactionSummary('用户要求暂停任务。\n\n## 当前任务与约束\n处理中。');

    expect(result.valid).toBe(false);
    expect(result.presentSectionCount).toBe(1);
    expect(result.missingSections).toContain('下一步动作');
    expect(result.maintenanceInstructionAttributedToUser).toBe(true);
  });
});
