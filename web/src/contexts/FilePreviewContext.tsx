import { createContext, useContext } from 'react';

/** 打开文件预览时的可选行为参数。 */
export interface OpenPreviewOptions {
  /**
   * 预览呈现模式：
   * - "dialog"（默认）：居中弹窗，覆盖主内容
   * - "side"：docked 到右侧面板，可在预览的同时继续对话
   *
   * 消息中的 md/PDF 附件卡首选 "side"，让用户可以边看文档边聊。
   */
  mode?: 'dialog' | 'side';
}

interface FilePreviewContextValue {
  openPreview: (filePath: string, owner?: string, options?: OpenPreviewOptions) => void;
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
