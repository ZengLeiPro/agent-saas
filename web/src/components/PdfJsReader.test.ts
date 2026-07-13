import { describe, expect, it } from 'vitest';
import { createPdfJsDocumentOptions, PDF_RANGE_CHUNK_SIZE } from './PdfJsReader';

describe('PDF.js 完整目录请求配置', () => {
  it('使用 Authorization header 和 64KB Range，禁用流式全量预取', () => {
    const options = createPdfJsDocumentOptions('/api/kb/file?path=catalog.pdf', 'jwt-token');
    expect(options).toEqual({
      url: '/api/kb/file?path=catalog.pdf',
      httpHeaders: { Authorization: 'Bearer jwt-token' },
      disableStream: true,
      disableAutoFetch: true,
      rangeChunkSize: 64 * 1024,
      withCredentials: false,
    });
    expect(PDF_RANGE_CHUNK_SIZE).toBe(65_536);
    expect(options.url).not.toContain('token=');
  });
});
