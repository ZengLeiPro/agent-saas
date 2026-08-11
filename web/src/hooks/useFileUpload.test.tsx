import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileUpload } from "./useFileUpload";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function uploadResponse(name: string) {
  return new Response(JSON.stringify({
    success: true,
    files: [{
      attachmentId: crypto.randomUUID(),
      originalName: name,
      relativePath: `uploads/${name}`,
      size: 1,
      mimeType: "text/plain",
      isImage: false,
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function pasteEvent(file: File) {
  return {
    clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

describe("useFileUpload 并发隔离", () => {
  beforeEach(() => mocks.authFetch.mockReset());

  it("并发上传全部结束前始终保持 uploading", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    mocks.authFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useFileUpload("taskboard"));

    let firstUpload!: Promise<void>;
    let secondUpload!: Promise<void>;
    act(() => {
      firstUpload = result.current.handlePaste(pasteEvent(new File(["a"], "a.txt")));
      secondUpload = result.current.handlePaste(pasteEvent(new File(["b"], "b.txt")));
    });
    expect(result.current.uploading).toBe(true);

    await act(async () => {
      first.resolve(uploadResponse("a.txt"));
      await firstUpload;
    });
    expect(result.current.uploading).toBe(true);

    await act(async () => {
      second.resolve(uploadResponse("b.txt"));
      await secondUpload;
    });
    expect(result.current.uploading).toBe(false);
    expect(result.current.uploadedFiles.map((file) => file.originalName)).toEqual(["a.txt", "b.txt"]);
  });

  it("清空或切换草稿后忽略旧上传响应", async () => {
    const pending = deferred<Response>();
    mocks.authFetch.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useFileUpload("taskboard"));

    let upload!: Promise<void>;
    act(() => {
      upload = result.current.handlePaste(pasteEvent(new File(["old"], "旧任务.txt")));
    });
    act(() => result.current.clearFiles());
    expect(result.current.uploading).toBe(false);

    await act(async () => {
      pending.resolve(uploadResponse("旧任务.txt"));
      await upload;
    });
    await waitFor(() => expect(result.current.uploadedFiles).toEqual([]));
  });
});
