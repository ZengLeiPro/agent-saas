import { describe, expect, it } from 'vitest';
import { normalizePreviewContent, preparePreviewText } from './previewTextFormat';

describe('normalizePreviewContent', () => {
  it('JSON 自动美化', () => {
    expect(normalizePreviewContent('{"a":1}', 'config.json')).toBe('{\n  "a": 1\n}');
    expect(normalizePreviewContent('{"a":1}', 'config.JSONC')).toBe('{\n  "a": 1\n}');
  });

  it('非法 JSON 保持原文，不抛错', () => {
    expect(normalizePreviewContent('{oops', 'config.json')).toBe('{oops');
  });

  it('非 JSON 文件原样返回', () => {
    expect(normalizePreviewContent('{"a":1}', 'a.ts')).toBe('{"a":1}');
  });
});

describe('preparePreviewText', () => {
  it('切行给行号槽，空文件也有一行', () => {
    expect(preparePreviewText('a\nb\nc', 'a.ts').lines).toEqual(['a', 'b', 'c']);
    expect(preparePreviewText('', 'a.ts').lines).toEqual(['']);
  });

  it('超过上限时截断并回报字节数', () => {
    const prepared = preparePreviewText('abcdefghij', 'a.txt', 4);
    expect(prepared.truncated).toBe(true);
    expect(prepared.totalBytes).toBe(10);
    expect(prepared.keptBytes).toBe(4);
    expect(prepared.lines).toEqual(['abcd']);
  });

  it('未超限不标记截断', () => {
    const prepared = preparePreviewText('abc', 'a.txt', 1024);
    expect(prepared).toEqual({ lines: ['abc'], truncated: false, totalBytes: 3, keptBytes: 3 });
  });

  it('截断作用在美化后的文本上（JSON 展开后可能变大）', () => {
    const prepared = preparePreviewText('{"a":1}', 'a.json', 5);
    expect(prepared.truncated).toBe(true);
    expect(prepared.lines[0]).toBe('{');
  });
});
