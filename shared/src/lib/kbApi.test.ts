import { describe, expect, it, vi } from 'vitest';

// kbApi 不走 fetch，仅用 getPlatform().platformConfig.getBaseUrl() 拼 URL。
// 只 mock platform context，返回固定 baseUrl。
vi.mock('../platform/context', () => ({
  getPlatform: () => ({
    platformConfig: { getBaseUrl: () => 'https://api.example.com' },
  }),
}));

import {
  KB_SCHEME,
  isKbPath,
  buildKbPreviewPath,
  parseKbPath,
  resolveKbFileSrc,
  buildKbPreviewManifestUrl,
  buildKbPreviewPageUrl,
} from './kbApi';

describe('kbApi 伪协议解析', () => {
  describe('isKbPath', () => {
    it('kb:// 前缀返回 true，普通路径 false', () => {
      expect(isKbPath('kb://doc.pdf')).toBe(true);
      expect(isKbPath('assets/a.pdf')).toBe(false);
    });
  });

  describe('buildKbPreviewPath', () => {
    it('无 page 时不带 fragment', () => {
      expect(buildKbPreviewPath('doc.pdf')).toBe('kb://doc.pdf');
    });

    it('有 page 时拼 #page=N', () => {
      expect(buildKbPreviewPath('doc.pdf', 3)).toBe('kb://doc.pdf#page=3');
    });

    it('page=0 视为 falsy，不带 fragment', () => {
      expect(buildKbPreviewPath('doc.pdf', 0)).toBe('kb://doc.pdf');
    });
  });

  describe('parseKbPath', () => {
    it('非 kb 路径返回 null', () => {
      expect(parseKbPath('assets/a.pdf')).toBeNull();
    });

    it('kb 但 doc 为空返回 null', () => {
      expect(parseKbPath(KB_SCHEME)).toBeNull();
    });

    it('无 page 时只返回 doc', () => {
      expect(parseKbPath('kb://doc.pdf')).toEqual({ doc: 'doc.pdf' });
    });

    it('合法 page 时带上 page', () => {
      expect(parseKbPath('kb://doc.pdf#page=5')).toEqual({ doc: 'doc.pdf', page: 5 });
    });

    it('page 非正整数被丢弃', () => {
      expect(parseKbPath('kb://doc.pdf#page=0')).toEqual({ doc: 'doc.pdf' });
      expect(parseKbPath('kb://doc.pdf#page=abc')).toEqual({ doc: 'doc.pdf' });
    });
  });
});

describe('kbApi URL 拼接', () => {
  describe('resolveKbFileSrc', () => {
    it('kb 路径提取 doc 后拼 /api/kb/file', async () => {
      await expect(resolveKbFileSrc('kb://folder/doc.pdf#page=2')).resolves.toBe(
        'https://api.example.com/api/kb/file?path=folder%2Fdoc.pdf',
      );
    });

    it('普通路径直接作为 path', async () => {
      await expect(resolveKbFileSrc('a/b.pdf')).resolves.toBe(
        'https://api.example.com/api/kb/file?path=a%2Fb.pdf',
      );
    });
  });

  describe('buildKbPreviewManifestUrl', () => {
    it('拼 /api/kb/preview-manifest', () => {
      expect(buildKbPreviewManifestUrl('doc.pdf')).toBe(
        'https://api.example.com/api/kb/preview-manifest?path=doc.pdf',
      );
    });
  });

  describe('buildKbPreviewPageUrl', () => {
    it('拼 /api/kb/preview 带 path/page/version', () => {
      expect(buildKbPreviewPageUrl('doc.pdf', 2, 'v1')).toBe(
        'https://api.example.com/api/kb/preview?path=doc.pdf&page=2&version=v1',
      );
    });

    it('page 非正整数抛错', () => {
      expect(() => buildKbPreviewPageUrl('doc.pdf', 0, 'v1')).toThrow('预览页码必须是正整数');
      expect(() => buildKbPreviewPageUrl('doc.pdf', 1.5, 'v1')).toThrow('预览页码必须是正整数');
    });
  });
});
