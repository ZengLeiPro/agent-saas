/**
 * PdfPreviewPanel kb 分支测试（计划用例 9）
 *
 * 9. kbSource：HEAD 预检 403 → error 态「文档不存在或知识库未开通」（不渲染 iframe）
 */
import { describe, expect, it, vi } from 'vitest';
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
    resolveKbFileSrc: vi.fn(async (path: string) => `https://example.test/api/kb/file?path=${encodeURIComponent(path)}&token=t`),
  };
});

describe('PdfPreviewPanel kb 分支', () => {
  it('用例9: HEAD 403 → error 态提示，不渲染 iframe', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    render(
      <PdfPreviewPanel filePath="catalog/无权限.pdf" kbSource page={3} onBack={() => undefined} hideHeader />,
    );
    await waitFor(() => {
      expect(screen.getByText('文档不存在或知识库未开通')).toBeTruthy();
    });
    expect(document.querySelector('iframe')).toBeNull();
    // HEAD 预检确实发出
    expect(authFetchMock).toHaveBeenCalledWith(
      `/api/kb/file?path=${encodeURIComponent('catalog/无权限.pdf')}`,
      { method: 'HEAD' },
    );
  });

  it('kbSource HEAD 200 → iframe 带 #page 定位', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    render(
      <PdfPreviewPanel filePath="catalog/手册.pdf" kbSource page={7} onBack={() => undefined} hideHeader />,
    );
    await waitFor(() => {
      expect(document.querySelector('iframe')).not.toBeNull();
    });
    const iframe = document.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toContain('#page=7');
    expect(iframe.getAttribute('src')).toContain('/api/kb/file');
  });
});
