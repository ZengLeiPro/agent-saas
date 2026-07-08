import { createContext, useContext } from 'react';

interface FilePreviewContextValue {
  openPreview: (filePath: string, owner?: string) => void;
  /** 当前会话所属用户（admin 查看其他用户会话时需要） */
  owner?: string;
  /** 只读分享页的公开访问 token，用于文件卡读取分享快照里的交付物。 */
  shareToken?: string;
}

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);

export const FilePreviewProvider = FilePreviewContext.Provider;

export function useFilePreview(): FilePreviewContextValue | null {
  return useContext(FilePreviewContext);
}
