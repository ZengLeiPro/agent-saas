/**
 * fileUtils.ts 测试
 *
 * - getPreviewFileType：文件名 → 可预览类型（html/md/pdf/text/code/video/null）
 * - parseToolResult：从 tool result JSON 提取图片块 + 文本
 * - resolveImageSrc：外部 URL 原样返回 + 工作区路径拼接带鉴权下载 URL（需 initPlatform）
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  getPreviewFileType,
  parseToolResult,
  resolveImageSrc,
  resolveTaskAttachmentSrc,
  truncateTextPreview,
} from './fileUtils';
import { ARTIFACT_TEXT_MAX_BYTES } from './artifactViewModel';
import { initPlatform } from '../platform/context';
import type { PlatformDeps } from '../platform/types';
import { TOKEN_KEY } from './constants';

describe('getPreviewFileType', () => {
  it('html/htm → html', () => {
    expect(getPreviewFileType('page.html')).toBe('html');
    expect(getPreviewFileType('page.HTM')).toBe('html');
  });

  it('md/markdown → md', () => {
    expect(getPreviewFileType('doc.md')).toBe('md');
    expect(getPreviewFileType('doc.markdown')).toBe('md');
  });

  it('pdf → pdf', () => {
    expect(getPreviewFileType('report.pdf')).toBe('pdf');
  });

  it('csv → text（在 code 判定前拦截）', () => {
    expect(getPreviewFileType('data.csv')).toBe('text');
  });

  it('源码类扩展名 → code', () => {
    expect(getPreviewFileType('main.ts')).toBe('code');
    expect(getPreviewFileType('config.yaml')).toBe('code');
  });

  it('视频类扩展名 → video', () => {
    expect(getPreviewFileType('clip.mp4')).toBe('video');
  });

  it('txt/log → text', () => {
    expect(getPreviewFileType('notes.txt')).toBe('text');
    expect(getPreviewFileType('server.log')).toBe('text');
  });

  it('rtf 虽属 text 类别但返回 null（富文本控制码，非纯文本）', () => {
    expect(getPreviewFileType('a.rtf')).toBeNull();
  });

  it('图片等不可预览类型返回 null', () => {
    expect(getPreviewFileType('a.png')).toBeNull();
    expect(getPreviewFileType('a.zip')).toBeNull();
    expect(getPreviewFileType('noext')).toBeNull();
  });
});

describe('parseToolResult', () => {
  it('MCP 格式图片块（data + mimeType）被提取', () => {
    const raw = JSON.stringify([{ type: 'image', data: 'BASE64', mimeType: 'image/jpeg' }]);
    expect(parseToolResult(raw)).toEqual({
      images: [{ data: 'BASE64', mimeType: 'image/jpeg' }],
      text: '',
    });
  });

  it('content block 格式图片（source.base64）被提取，media_type 缺省为 image/png', () => {
    const raw = JSON.stringify([{ type: 'image', source: { type: 'base64', data: 'B64' } }]);
    expect(parseToolResult(raw)).toEqual({
      images: [{ data: 'B64', mimeType: 'image/png' }],
      text: '',
    });
  });

  it('图片 + 文本块混排：图片进 images，文本 join 进 text', () => {
    const raw = JSON.stringify([
      { type: 'text', text: '看这张图' },
      { type: 'image', data: 'IMG', mimeType: 'image/png' },
    ]);
    expect(parseToolResult(raw)).toEqual({
      images: [{ data: 'IMG', mimeType: 'image/png' }],
      text: '看这张图',
    });
  });

  it('无图片时（纯 JSON 文本）回退为 { images: [], text: 原始串 }', () => {
    // 无图片则整体走「回退为纯文本」，text 为原始输入串
    const raw = JSON.stringify([{ type: 'text', text: '只有文字' }]);
    expect(parseToolResult(raw)).toEqual({ images: [], text: raw });
  });

  it('非 JSON 输入回退为纯文本', () => {
    expect(parseToolResult('plain text result')).toEqual({ images: [], text: 'plain text result' });
  });

  it('单对象（非数组）也被包装处理', () => {
    const raw = JSON.stringify({ type: 'image', data: 'X', mimeType: 'image/gif' });
    expect(parseToolResult(raw)).toEqual({ images: [{ data: 'X', mimeType: 'image/gif' }], text: '' });
  });
});

describe('resolveImageSrc', () => {
  beforeEach(() => {
    const deps = {
      secureStorage: {
        getItem: async (key: string) => (key === TOKEN_KEY ? 'TOK123' : null),
        setItem: async () => {},
        removeItem: async () => {},
      },
      platformConfig: {
        getBaseUrl: () => 'https://api.example.com',
        getWsUrl: () => '',
        platform: 'web' as const,
      },
    } as unknown as PlatformDeps;
    initPlatform(deps);
  });

  it('外部 URL（https/data/blob）原样返回', async () => {
    await expect(resolveImageSrc('https://cdn/x.png')).resolves.toBe('https://cdn/x.png');
    await expect(resolveImageSrc('data:image/png;base64,AAA')).resolves.toBe('data:image/png;base64,AAA');
    await expect(resolveImageSrc('blob:abc')).resolves.toBe('blob:abc');
  });

  it('工作区路径拼接带 token 的下载 URL，path 经过 encodeURIComponent', async () => {
    const url = await resolveImageSrc('assets/图片.png');
    expect(url).toContain('https://api.example.com/api/file/download?path=');
    expect(url).toContain(encodeURIComponent('assets/图片.png'));
    expect(url).toContain('token=TOK123');
  });

  it('传入 owner / referrer 时附加对应查询参数', async () => {
    const url = await resolveImageSrc('a/b.png', 'alice', 'docs/readme.md');
    expect(url).toContain(`owner=${encodeURIComponent('alice')}`);
    expect(url).toContain(`referrer=${encodeURIComponent('docs/readme.md')}`);
  });

  it('M10-01: attachment URL policy runs before reading a token', async () => {
    const tokenRead = vi.fn(async () => 'must-not-leave-storage');
    const policyGuard = vi.fn(() => {
      throw new Error('untrusted attachment origin');
    });
    initPlatform({
      secureStorage: {
        getItem: tokenRead,
        setItem: async () => {},
        removeItem: async () => {},
      },
      platformConfig: {
        getBaseUrl: () => 'https://attacker.test',
        getWsUrl: () => '',
        assertTrustedUrl: policyGuard,
        platform: 'mobile',
      },
    } as unknown as PlatformDeps);

    await expect(resolveTaskAttachmentSrc('task-1', 'attachment-1'))
      .rejects.toThrow('untrusted attachment origin');
    expect(policyGuard).toHaveBeenCalledWith(
      'https://attacker.test/api/taskboard/tasks/task-1/attachments/attachment-1',
      'http',
    );
    expect(tokenRead).not.toHaveBeenCalled();
  });
});

describe('truncateTextPreview', () => {
  it('未超限时原样返回', () => {
    const result = truncateTextPreview('hello', 1024);
    expect(result).toEqual({ text: 'hello', truncated: false, totalBytes: 5, keptBytes: 5 });
  });

  it('默认上限与 Artifact 文本视图一致', () => {
    const result = truncateTextPreview('a'.repeat(10));
    expect(result.truncated).toBe(false);
    expect(ARTIFACT_TEXT_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('超限时按字节截断并标记 truncated', () => {
    const result = truncateTextPreview('abcdef', 3);
    expect(result).toEqual({ text: 'abc', truncated: true, totalBytes: 6, keptBytes: 3 });
  });

  it('截断点对齐 UTF-8 字符边界，不产生半个中文字符', () => {
    // '中' = 3 字节；上限 4 时只能保留一个完整字符
    const result = truncateTextPreview('中文', 4);
    expect(result.text).toBe('中');
    expect(result.keptBytes).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(6);
  });

  it('上限非正数时返回空串', () => {
    expect(truncateTextPreview('abc', 0)).toEqual({
      text: '', truncated: true, totalBytes: 3, keptBytes: 0,
    });
  });
});
