import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PdfPreviewPanel } from './PdfPreviewPanel';

const authFetchMock = vi.fn();
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  setOnUnauthorized: vi.fn(),
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    buildKbPreviewManifestUrl: (path: string) => `/api/kb/preview-manifest?path=${encodeURIComponent(path)}`,
    buildKbPreviewPageUrl: (path: string, page: number, version: string) => `/api/kb/preview?path=${encodeURIComponent(path)}&page=${page}&version=${version}`,
  };
});

const manifest = {
  schemaVersion: 1,
  sourcePath: 'catalog/手册.pdf',
  sourceSha256: 'a'.repeat(64),
  sourceSize: 38_758_136,
  sourceMtimeMs: 1,
  pageCount: 122,
  width: 1600,
  format: 'webp',
  quality: 80,
  generatedAt: '2026-07-13T00:00:00.000Z',
};

describe('PdfPreviewPanel KB 单页预览', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview-page') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('预览缺失时明确降级到 PDF.js 入口，不渲染原生 iframe', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'missing' }), { status: 404 }));
    render(<PdfPreviewPanel filePath="catalog/无权限.pdf" kbSource page={3} onBack={() => undefined} hideHeader />);
    await waitFor(() => expect(screen.getByText('该页预览暂未生成')).toBeTruthy());
    expect(screen.getByRole('button', { name: '使用完整目录阅读器' })).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    expect(authFetchMock).toHaveBeenCalledWith(`/api/kb/preview-manifest?path=${encodeURIComponent('catalog/无权限.pdf')}`);
  });

  it('首屏只请求准确的 1-based 单页 WebP，不请求完整 PDF', async () => {
    authFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Blob(['small-webp']), { status: 200, headers: { 'Content-Type': 'image/webp' } }));
    render(<PdfPreviewPanel filePath="catalog/手册.pdf" kbSource page={7} onBack={() => undefined} hideHeader />);
    await waitFor(() => expect(screen.getByAltText('手册.pdf 第 7 页')).toBeTruthy());
    expect(authFetchMock).toHaveBeenNthCalledWith(1, `/api/kb/preview-manifest?path=${encodeURIComponent('catalog/手册.pdf')}`);
    expect(authFetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('page=7&version='));
    expect(authFetchMock.mock.calls.some(([url]) => String(url).includes('/api/kb/file'))).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('/ 122 页')).toBeTruthy();
  });

  it('右侧预览未关闭时点击同一 PDF 的另一页，会切换到新的引用页', async () => {
    authFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Blob(['page-7']), { status: 200, headers: { 'Content-Type': 'image/webp' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Blob(['page-12']), { status: 200, headers: { 'Content-Type': 'image/webp' } }));

    const view = render(<PdfPreviewPanel filePath="catalog/手册.pdf" kbSource page={7} onBack={() => undefined} hideHeader />);
    await waitFor(() => expect(screen.getByAltText('手册.pdf 第 7 页')).toBeTruthy());

    view.rerender(<PdfPreviewPanel filePath="catalog/手册.pdf" kbSource page={12} onBack={() => undefined} hideHeader />);

    await waitFor(() => expect(screen.getByAltText('手册.pdf 第 12 页')).toBeTruthy());
    expect(authFetchMock).toHaveBeenNthCalledWith(4, expect.stringContaining('page=12&version='));
  });
});
