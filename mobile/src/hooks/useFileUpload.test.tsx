// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  authFetch: vi.fn(),
  getDocumentAsync: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return { ...actual, authFetch: h.authFetch };
});
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, Alert: { alert: h.alert } };
});
vi.mock('expo-document-picker', () => ({ getDocumentAsync: h.getDocumentAsync }));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: vi.fn(),
  SaveFormat: { JPEG: 'jpeg' },
}));
vi.mock('expo-file-system', () => ({
  File: class {
    exists = true;
    size = 3;
    constructor(public uri: string) {}
  },
}));
vi.mock('../platform/jitMediaPermissions', () => ({
  launchCameraForUserAction: vi.fn(),
  launchPhotoLibraryForUserAction: vi.fn(),
}));

import { useFileUpload } from './useFileUpload';

const ATTACHMENT_ID = '11111111-2222-4333-8444-555555555555';
const serverFile = {
  attachmentId: ATTACHMENT_ID,
  originalName: 'doc.txt',
  relativePath: 'uploads/doc.txt',
  size: 3,
  mimeType: 'text/plain',
  isImage: false,
};

describe('useFileUpload（mobile）消费 shared 附件上传内核', () => {
  beforeEach(() => {
    h.authFetch.mockReset();
    h.getDocumentAsync.mockReset();
    h.alert.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('系统选择器选中后上传成功，附件带 attachmentId；consume 取走即清且清空错误', async () => {
    h.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/doc.txt', name: 'doc.txt', mimeType: 'text/plain' }],
    });
    h.authFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, files: [serverFile] }),
    });
    const { result } = renderHook(() => useFileUpload({ available: true, identityKey: 'u1' }));

    await act(async () => {
      await result.current.pickFile();
    });
    expect(h.authFetch).toHaveBeenCalledWith(
      '/api/upload',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.uploadedFiles).toEqual([
      expect.objectContaining({ attachmentId: ATTACHMENT_ID }),
    ]);
    expect(result.current.uploading).toBe(false);
    // 状态里永远没有本地 URI
    expect(JSON.stringify(result.current.uploadedFiles)).not.toContain('file://');

    let consumed: unknown[] = [];
    act(() => {
      consumed = result.current.consumeFiles();
    });
    expect(consumed).toHaveLength(1);
    expect(result.current.uploadedFiles).toEqual([]);
  });

  it('锁定或离线时拒绝上传；身份切换作废在途上传并提示', async () => {
    const { result, rerender } = renderHook(
      ({ available, identityKey }) => useFileUpload({ available, identityKey }),
      { initialProps: { available: false, identityKey: 'u1' } },
    );
    h.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/a.txt', name: 'a.txt', mimeType: 'text/plain' }],
    });
    await act(async () => {
      await result.current.pickFile();
    });
    expect(result.current.uploadError).toBe('应用已锁定或离线，无法上传');
    expect(h.authFetch).not.toHaveBeenCalled();

    rerender({ available: true, identityKey: 'u1' });
    let resolveUpload!: () => void;
    h.authFetch.mockReturnValue(
      new Promise<unknown>((done) => {
        resolveUpload = () =>
          done({
            ok: true,
            status: 200,
            json: async () => ({ success: true, files: [serverFile] }),
          });
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.pickFile();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.uploading).toBe(true);

    rerender({ available: true, identityKey: 'u2' });
    expect(result.current.uploading).toBe(false);
    expect(result.current.uploadError).toBe('身份已切换，请重新选择文件');
    await act(async () => {
      resolveUpload();
      await pending;
    });
    expect(result.current.uploadedFiles).toEqual([]);
  });

  it('addUploadedFiles 只接受带合法 attachmentId 的附件', () => {
    const { result } = renderHook(() => useFileUpload());
    act(() => {
      result.current.addUploadedFiles([{ ...serverFile, attachmentId: undefined }]);
    });
    expect(result.current.uploadedFiles).toEqual([]);
    expect(result.current.uploadError).toMatch(/^附件不可发送：/);
    act(() => {
      result.current.addUploadedFiles([serverFile]);
    });
    expect(result.current.uploadedFiles).toHaveLength(1);
  });
});
