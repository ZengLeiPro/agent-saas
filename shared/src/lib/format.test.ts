/**
 * format.ts 测试
 *
 * truncateContent / formatJson / formatFileSize 三个纯格式化函数。
 * 覆盖正常路径 + 边界（空串、单行、恰好等于 maxLines、极值字节数）+ 异常输入。
 */
import { describe, expect, it } from 'vitest';
import { truncateContent, formatJson, formatFileSize } from './format';

describe('truncateContent', () => {
  it('行数不超过 maxLines 时原样返回，truncated=false', () => {
    expect(truncateContent('a\nb')).toEqual({ text: 'a\nb', truncated: false });
  });

  it('行数恰好等于 maxLines 不截断（边界）', () => {
    expect(truncateContent('l1\nl2', 2)).toEqual({ text: 'l1\nl2', truncated: false });
  });

  it('超过 maxLines 时截断并追加省略号，truncated=true', () => {
    expect(truncateContent('l1\nl2\nl3\nl4', 2)).toEqual({ text: 'l1\nl2...', truncated: true });
  });

  it('自定义 maxLines=1 只保留首行', () => {
    expect(truncateContent('first\nsecond', 1)).toEqual({ text: 'first...', truncated: true });
  });

  it('空字符串（单行）不截断', () => {
    expect(truncateContent('')).toEqual({ text: '', truncated: false });
  });
});

describe('formatJson', () => {
  it('合法 JSON 字符串被格式化为 2 空格缩进', () => {
    expect(formatJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it('非法 JSON 原样返回（不抛异常）', () => {
    expect(formatJson('not json {')).toBe('not json {');
  });

  it('空字符串原样返回（解析失败分支）', () => {
    expect(formatJson('')).toBe('');
  });
});

describe('formatFileSize', () => {
  it('小于 1KB 显示为 B', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('0 字节显示为 0 B（下边界）', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('1023 字节仍为 B（KB 边界前一位）', () => {
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('恰好 1024 字节进位为 KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
  });

  it('KB 量级保留 1 位小数', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('MB 量级保留 1 位小数', () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('GB 量级保留 2 位小数', () => {
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });
});
