/** P3-3d：附件存储用量投影与清理确认文案的纯函数测试。 */
import { describe, expect, it } from 'vitest';
import {
  attachmentPartialNotice,
  attachmentUsageRows,
  purgeAllAction,
  stagedCleanupAction,
  type AttachmentUsage,
} from './attachmentUsage';

const usage: AttachmentUsage = {
  totalBytes: 3 * 1024 * 1024,
  totalFiles: 12,
  stagedBytes: 512 * 1024,
  stagedFiles: 3,
  referencedBytes: 2 * 1024 * 1024,
  referencedFiles: 8,
  legacyBytes: 1024,
  legacyFiles: 1,
  partialBytes: 2048,
  partialFiles: 2,
  stagedRetentionHours: 24,
  measuredAt: '2026-09-05T00:00:00.000Z',
};

describe('attachmentUsageRows', () => {
  it('四行与 Web 的 UsageCard 同名同序，容量已格式化', () => {
    const rows = attachmentUsageRows(usage);
    expect(rows.map((row) => row.key)).toEqual(['total', 'referenced', 'staged', 'legacy']);
    expect(rows.map((row) => row.label)).toEqual(['附件总量', '已发送', '未发送', '其他/历史']);
    expect(rows[0].value).toBe('3.0 MB');
    expect(rows[2].hint).toBe('3 个文件 · 24 小时后自动清理');
  });
});

describe('attachmentPartialNotice', () => {
  it('存在临时文件时给出提示', () => {
    expect(attachmentPartialNotice(usage)).toContain('另有 2 个传输中或异常中断的临时文件');
  });
  it('没有临时文件时返回 null（不渲染空提示）', () => {
    expect(attachmentPartialNotice({ ...usage, partialFiles: 0 })).toBeNull();
  });
});

describe('清理动作文案', () => {
  it('有未发送附件：按钮带数量，确认文案说明不动已发送附件', () => {
    const action = stagedCleanupAction(usage);
    expect(action.actionLabel).toBe('清理 3 个');
    expect(action.disabled).toBe(false);
    expect(action.confirmMessage).toContain('512.0 KB');
    expect(action.confirmMessage).toContain('已发送附件和历史文件不会删除');
  });

  it('无未发送附件：禁用并提示无需清理', () => {
    const action = stagedCleanupAction({ ...usage, stagedFiles: 0, stagedBytes: 0 });
    expect(action.actionLabel).toBe('无需清理');
    expect(action.disabled).toBe(true);
  });

  it('清空全部：确认文案点名已发送附件数量与不可恢复', () => {
    const action = purgeAllAction(usage);
    expect(action.actionLabel).toBe('清空 12 个');
    expect(action.confirmMessage).toContain('8 个已发送附件');
    expect(action.confirmMessage).toContain('不可恢复');
  });

  it('用量未加载（null）时两个动作都禁用', () => {
    expect(stagedCleanupAction(null).disabled).toBe(true);
    expect(purgeAllAction(null).disabled).toBe(true);
    expect(purgeAllAction(null).actionLabel).toBe('已无附件');
  });
});
