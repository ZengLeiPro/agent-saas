export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  extension: string;
}

export interface FileListResponse {
  entries: FileEntry[];
  currentPath: string;
  parentPath: string | null;
}

export type FileSortKey = "name" | "modifiedAt" | "size" | "extension";
export type FileSortOrder = "asc" | "desc";

export const FILE_SORT_LABELS: Record<FileSortKey, string> = {
  name: "名称",
  modifiedAt: "修改时间",
  size: "大小",
  extension: "类型",
};
