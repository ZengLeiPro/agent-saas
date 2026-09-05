import { describe, expect, it } from 'vitest';
import { buildFileDeletePlan, buildFileDeleteUrl, summarizeDeleteResult } from './fileDeletePlan';

const file = { path: 'assets/a.md', name: 'a.md', isDirectory: false };
const dir = { path: 'assets/docs', name: 'docs', isDirectory: true };

describe('buildFileDeletePlan', () => {
  it('空选区不弹二次确认', () => {
    expect(buildFileDeletePlan([])).toBeNull();
  });

  it('单文件文案与 Web 删除对话框对齐', () => {
    expect(buildFileDeletePlan([file])).toEqual({
      title: '删除文件',
      message: '确定要删除 a.md 吗？此操作不可撤销。',
      confirmLabel: '删除',
      paths: ['assets/a.md'],
    });
  });

  it('单文件夹补充「文件夹内的所有内容都将被删除。」', () => {
    expect(buildFileDeletePlan([dir])?.message).toBe(
      '确定要删除 docs 吗？文件夹内的所有内容都将被删除。此操作不可撤销。',
    );
    expect(buildFileDeletePlan([dir])?.title).toBe('删除文件夹');
  });

  it('多选按数量出文案，含目录时保留目录警告', () => {
    const plan = buildFileDeletePlan([file, dir]);
    expect(plan?.title).toBe('删除 2 个项目');
    expect(plan?.message).toContain('文件夹内的所有内容都将被删除。');
    expect(plan?.confirmLabel).toBe('删除 2 项');
    expect(plan?.paths).toEqual(['assets/a.md', 'assets/docs']);
  });

  it('多选全是文件时不出目录警告', () => {
    const plan = buildFileDeletePlan([file, { ...file, path: 'assets/b.md', name: 'b.md' }]);
    expect(plan?.message).not.toContain('文件夹内');
  });
});

describe('buildFileDeleteUrl', () => {
  it('端点与 Web 一致，owner/root 仅在给值时下发', () => {
    expect(buildFileDeleteUrl('assets/a.md')).toBe('/api/file/delete?path=assets%2Fa.md');
    expect(buildFileDeleteUrl('assets/a.md', 'alice')).toBe(
      '/api/file/delete?path=assets%2Fa.md&owner=alice',
    );
    expect(buildFileDeleteUrl('.', undefined, true)).toBe('/api/file/delete?path=.&root=true');
  });

  it('中文与空格路径正确编码', () => {
    expect(buildFileDeleteUrl('assets/我的 报告.md')).toBe(
      '/api/file/delete?path=assets%2F%E6%88%91%E7%9A%84+%E6%8A%A5%E5%91%8A.md',
    );
  });
});

describe('summarizeDeleteResult', () => {
  it('全部成功不打扰用户', () => {
    expect(summarizeDeleteResult(3, 0)).toBeNull();
  });

  it('全失败与部分失败分别出文案', () => {
    expect(summarizeDeleteResult(3, 3)).toBe('删除失败');
    expect(summarizeDeleteResult(3, 1)).toBe('1/3 项删除失败');
  });
});
