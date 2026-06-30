import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { UploadedFile } from '@agent/shared';

/**
 * 跨路由传递「分享上传完成、等待目标会话挂载后注入输入框附件区」的文件列表。
 *
 * 数据流：
 *   share-target 页面上传完成 → setPending(files)
 *   → router.push('/chat/{id}')
 *   → chat/[sessionId].tsx mount 时 consume() 取走并清空
 *   → 灌入 useFileUpload state，等用户补一句话发送
 *
 * 与 useFileUpload 内的 uploadedFiles 不混用：那个 hook 实例是会话页面绑定的，
 * 在 mount 之前不存在；这里是全局轻量 store，只做"过桥"。
 */
interface PendingSharedFilesState {
  /** 当前等待消费的文件；mount 时立即取走，不持久化、不监听 */
  hasPending: () => boolean;
  setPending: (files: UploadedFile[]) => void;
  /** 取走 + 清空，与 useFileUpload.consumeFiles 同语义 */
  consume: () => UploadedFile[];
  clear: () => void;
}

const PendingSharedFilesContext = createContext<PendingSharedFilesState | null>(null);

export function PendingSharedFilesProvider({ children }: { children: React.ReactNode }) {
  // 用 ref 存数据避免每次 setPending 都触发整树 re-render；用 state 仅维护 version 标志
  const filesRef = useRef<UploadedFile[]>([]);
  const [, setVersion] = useState(0);

  const setPending = useCallback((files: UploadedFile[]) => {
    filesRef.current = files;
    setVersion(v => v + 1);
  }, []);

  const consume = useCallback((): UploadedFile[] => {
    const current = filesRef.current;
    filesRef.current = [];
    if (current.length) setVersion(v => v + 1);
    return current;
  }, []);

  const clear = useCallback(() => {
    if (filesRef.current.length === 0) return;
    filesRef.current = [];
    setVersion(v => v + 1);
  }, []);

  const hasPending = useCallback(() => filesRef.current.length > 0, []);

  return (
    <PendingSharedFilesContext.Provider value={{ hasPending, setPending, consume, clear }}>
      {children}
    </PendingSharedFilesContext.Provider>
  );
}

export function usePendingSharedFiles(): PendingSharedFilesState {
  const ctx = useContext(PendingSharedFilesContext);
  if (!ctx) throw new Error('usePendingSharedFiles must be used within PendingSharedFilesProvider');
  return ctx;
}
