import { describe, expect, it } from 'vitest';
import {
  resolveFilePreviewKind,
  resolveFilePreviewTarget,
  resolveKbPreviewSource,
} from './filePreviewTarget';

describe('resolveFilePreviewKind', () => {
  it('五类可预览类型分派', () => {
    expect(resolveFilePreviewKind('note.md')).toBe('markdown');
    expect(resolveFilePreviewKind('index.ts')).toBe('code');
    expect(resolveFilePreviewKind('log.txt')).toBe('text');
    expect(resolveFilePreviewKind('data.csv')).toBe('text');
    expect(resolveFilePreviewKind('report.pdf')).toBe('pdf');
    expect(resolveFilePreviewKind('clip.mp4')).toBe('video');
  });

  it('HTML/SVG 一律降级为 html 档（M50：移动端不内嵌渲染主动内容）', () => {
    expect(resolveFilePreviewKind('page.html')).toBe('html');
    expect(resolveFilePreviewKind('page.HTM')).toBe('html');
    expect(resolveFilePreviewKind('chart.svg')).toBe('html');
    expect(resolveFilePreviewKind('chart.svgz')).toBe('html');
    expect(resolveFilePreviewKind('page.xhtml')).toBe('html');
  });

  it('不可预览类型落到 download', () => {
    expect(resolveFilePreviewKind('photo.png')).toBe('download');
    expect(resolveFilePreviewKind('archive.zip')).toBe('download');
    expect(resolveFilePreviewKind('sheet.xlsx')).toBe('download');
    expect(resolveFilePreviewKind('无扩展名')).toBe('download');
  });

  it('kb:// 伪协议按 doc 文件名判定，页码不影响类型', () => {
    expect(resolveFilePreviewKind('kb://手册.pdf#page=12')).toBe('pdf');
    expect(resolveFilePreviewKind('kb://readme.md')).toBe('markdown');
    expect(resolveFilePreviewKind('kb://danger.svg')).toBe('html');
  });
});

describe('resolveFilePreviewTarget', () => {
  it('Markdown 保留会话内既有入口', () => {
    expect(resolveFilePreviewTarget('a.md')).toEqual({
      kind: 'markdown',
      route: '/chat/markdown-preview',
    });
  });

  it('code/text/pdf/video/html 进通用预览路由', () => {
    for (const [name, kind] of [
      ['a.ts', 'code'],
      ['a.log', 'text'],
      ['a.pdf', 'pdf'],
      ['a.mov', 'video'],
      ['a.html', 'html'],
    ] as const) {
      expect(resolveFilePreviewTarget(name), name).toEqual({ kind, route: '/files/preview' });
    }
  });

  it('download 档不跳转（直接下载/分享）', () => {
    expect(resolveFilePreviewTarget('a.zip')).toEqual({ kind: 'download', route: null });
  });
});

describe('resolveKbPreviewSource', () => {
  it('非 kb 路径原样返回', () => {
    expect(resolveKbPreviewSource('assets/a.pdf')).toEqual({ isKb: false, doc: 'assets/a.pdf' });
  });

  it('解析 doc 与页码', () => {
    expect(resolveKbPreviewSource('kb://手册.pdf#page=12')).toEqual({
      isKb: true,
      doc: '手册.pdf',
      page: 12,
    });
    expect(resolveKbPreviewSource('kb://手册.pdf')).toEqual({ isKb: true, doc: '手册.pdf' });
  });

  it('非法页码丢弃，空 doc 返回空串', () => {
    expect(resolveKbPreviewSource('kb://a.pdf#page=0').page).toBeUndefined();
    expect(resolveKbPreviewSource('kb://')).toEqual({ isKb: true, doc: '' });
  });
});
