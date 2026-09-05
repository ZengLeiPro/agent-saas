import { describe, expect, it } from 'vitest';
import { resolveFileReadSource } from './fileReadSource';

describe('resolveFileReadSource', () => {
  it('工作区路径走 /api/file/read（默认 route）', () => {
    expect(resolveFileReadSource('assets/a.md')).toEqual({
      kind: 'workspace',
      doc: 'assets/a.md',
      workspaceUrl: '/api/file/read?path=assets%2Fa.md',
    });
  });

  it('route=download 切到下载端点，owner/root 透传', () => {
    expect(
      resolveFileReadSource('assets/a.pdf', 'download', { owner: 'alice', root: true })
        .workspaceUrl,
    ).toBe('/api/file/download?path=assets%2Fa.pdf&owner=alice&root=true');
  });

  it('kb:// 路径分流到 KB 分支，不再生成工作区 URL（P1 404 修复点）', () => {
    expect(resolveFileReadSource('kb://手册.pdf#page=7')).toEqual({
      kind: 'kb',
      doc: '手册.pdf',
      page: 7,
      workspaceUrl: null,
    });
  });

  it('KB 根文档（无目录前缀）同样走 KB 分支', () => {
    expect(resolveFileReadSource('kb://产品白皮书.pdf')).toEqual({
      kind: 'kb',
      doc: '产品白皮书.pdf',
      workspaceUrl: null,
    });
  });

  it('kb 路径的 owner/root 不参与拼装（KB 是租户共享只读）', () => {
    const source = resolveFileReadSource('kb://a.pdf', 'download', { owner: 'bob', root: true });
    expect(source.kind).toBe('kb');
    expect(source.workspaceUrl).toBeNull();
  });

  it('畸形 kb 路径退化为空 doc，调用方据此报错而不是打错端点', () => {
    expect(resolveFileReadSource('kb://')).toEqual({
      kind: 'kb',
      doc: '',
      workspaceUrl: null,
    });
  });
});
