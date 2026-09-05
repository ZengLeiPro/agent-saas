/**
 * 文件删除的纯逻辑（文案 / 请求路径 / 结果汇总），不含 React 与 RN 依赖，可单测。
 *
 * 端点以 Web `FileBrowser` 为准：`DELETE /api/file/delete?path=&owner=`；
 * 移动端多出一个 `root=true`（管理员根目录浏览），与 `useFileList` 同一口径。
 * 二次确认文案与 Web 删除对话框逐字对齐（「此操作不可撤销。」）。
 */

export interface DeletableEntry {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface FileDeletePlan {
  title: string;
  message: string;
  confirmLabel: string;
  paths: string[];
}

/** 空选区返回 null（调用方据此不弹面板） */
export function buildFileDeletePlan(entries: readonly DeletableEntry[]): FileDeletePlan | null {
  if (entries.length === 0) return null;
  const hasDirectory = entries.some((entry) => entry.isDirectory);
  const folderNote = hasDirectory ? '文件夹内的所有内容都将被删除。' : '';

  if (entries.length === 1) {
    const [entry] = entries;
    const typeLabel = entry.isDirectory ? '文件夹' : '文件';
    return {
      title: `删除${typeLabel}`,
      message: `确定要删除 ${entry.name} 吗？${folderNote}此操作不可撤销。`,
      confirmLabel: '删除',
      paths: [entry.path],
    };
  }

  return {
    title: `删除 ${entries.length} 个项目`,
    message: `确定要删除选中的 ${entries.length} 个项目吗？${folderNote}此操作不可撤销。`,
    confirmLabel: `删除 ${entries.length} 项`,
    paths: entries.map((entry) => entry.path),
  };
}

/** 删除请求的相对路径（交给 authFetch 拼 baseUrl） */
export function buildFileDeleteUrl(path: string, owner?: string, root?: boolean): string {
  const params = new URLSearchParams({ path });
  if (owner) params.set('owner', owner);
  if (root) params.set('root', 'true');
  return `/api/file/delete?${params.toString()}`;
}

/** 批量删除结果文案；全部成功返回 null（不打扰用户） */
export function summarizeDeleteResult(total: number, failed: number): string | null {
  if (failed <= 0) return null;
  if (failed === total) return '删除失败';
  return `${failed}/${total} 项删除失败`;
}
