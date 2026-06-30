import { createContext, useContext } from 'react';

interface FilePreviewContextValue {
  openPreview: (filePath: string, owner?: string) => void;
  /** 当前会话所属用户（admin 查看其他用户会话时需要） */
  owner?: string;
}

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);

export const FilePreviewProvider = FilePreviewContext.Provider;

export function useFilePreview(): FilePreviewContextValue | null {
  return useContext(FilePreviewContext);
}
