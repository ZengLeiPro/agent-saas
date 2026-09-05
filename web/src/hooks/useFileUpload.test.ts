import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch: authFetchMock }));

import { useFileUpload } from './useFileUpload';

const ATTACHMENT_ID = '11111111-2222-4333-8444-555555555555';

function serverFile(name: string, isImage = false) {
  return {
    attachmentId: ATTACHMENT_ID,
    originalName: name,
    relativePath: `uploads/${name}`,
    size: 3,
    mimeType: isImage ? 'image/png' : 'text/plain',
    isImage,
  };
}

function deferredResponse(body: unknown, ok = true) {
  let resolve!: () => void;
  const promise = new Promise<Response>((done) => {
    resolve = () =>
      done({ ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response);
  });
  return { promise, resolve };
}

function dropEvent(files: File[]) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { types: ['Files'], files },
  } as unknown as React.DragEvent;
}

describe('useFileUpload（Web）消费 shared 附件上传内核', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('拖入上传成功后附件带 attachmentId，图片补 previewUrl；consume 取走即清', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, files: [serverFile('a.png', true)] }),
    });
    const { result } = renderHook(() =>
      useFileUpload('chat', () => 'session-1', { online: true, identityKey: 'u1' }),
    );

    await act(async () => {
      await result.current.handleDrop(
        dropEvent([new File(['abc'], 'a.png', { type: 'image/png' })]),
      );
    });

    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/upload?sessionId=session-1',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.uploadedFiles).toEqual([
      expect.objectContaining({ attachmentId: ATTACHMENT_ID, previewUrl: 'blob:preview' }),
    ]);
    expect(result.current.uploading).toBe(false);

    let consumed: unknown[] = [];
    act(() => {
      consumed = result.current.consumeFiles();
    });
    expect(consumed).toHaveLength(1);
    expect(result.current.uploadedFiles).toEqual([]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled(); // consume 不释放 preview，交给调用方
  });

  it('身份切换时作废在途上传：晚到的响应被丢弃、uploading 回落并给出提示', async () => {
    const deferred = deferredResponse({ success: true, files: [serverFile('late.txt')] });
    authFetchMock.mockReturnValue(deferred.promise);
    const { result, rerender } = renderHook(
      ({ identityKey }) => useFileUpload('chat', undefined, { online: true, identityKey }),
      { initialProps: { identityKey: 'u1' } },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleDrop(
        dropEvent([new File(['abc'], 'late.txt', { type: 'text/plain' })]),
      );
    });
    expect(result.current.uploading).toBe(true);

    rerender({ identityKey: 'u2' });
    expect(result.current.uploading).toBe(false);
    expect(result.current.uploadError).toBe('身份已切换，请重新选择文件');

    await act(async () => {
      deferred.resolve();
      await pending;
    });
    expect(result.current.uploadedFiles).toEqual([]);
    expect(result.current.uploadError).toBe('身份已切换，请重新选择文件');
  });

  it('离线时拒绝上传；服务端失败写入上传失败提示；removeFile 释放 preview', async () => {
    const { result, rerender } = renderHook(
      ({ online }) => useFileUpload('chat', undefined, { online, identityKey: 'u1' }),
      { initialProps: { online: false } },
    );
    await act(async () => {
      await result.current.handleDrop(
        dropEvent([new File(['abc'], 'a.txt', { type: 'text/plain' })]),
      );
    });
    expect(result.current.uploadError).toBe('当前离线，无法上传');
    expect(authFetchMock).not.toHaveBeenCalled();

    rerender({ online: true });
    authFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: '磁盘已满' }),
    });
    await act(async () => {
      await result.current.handleDrop(
        dropEvent([new File(['abc'], 'a.txt', { type: 'text/plain' })]),
      );
    });
    expect(result.current.uploadError).toBe('上传失败：磁盘已满');

    authFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, files: [serverFile('b.png', true)] }),
    });
    await act(async () => {
      await result.current.handleDrop(
        dropEvent([new File(['abc'], 'b.png', { type: 'image/png' })]),
      );
    });
    expect(result.current.uploadError).toBeNull();
    act(() => {
      result.current.removeFile(0);
    });
    expect(result.current.uploadedFiles).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('服务端返回无效 attachmentId 时按上传失败处理', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        files: [{ ...serverFile('x.txt'), attachmentId: 'bad' }],
      }),
    });
    const { result } = renderHook(() => useFileUpload('chat'));
    await act(async () => {
      await result.current.handleDrop(
        dropEvent([new File(['abc'], 'x.txt', { type: 'text/plain' })]),
      );
    });
    expect(result.current.uploadedFiles).toEqual([]);
    expect(result.current.uploadError).toMatch(/^上传失败：/);
  });
});
