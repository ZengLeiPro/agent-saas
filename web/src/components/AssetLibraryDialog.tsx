import { useMemo, useState } from "react";
import { Check, ChevronRight, FileArchive, Folder, Loader2 } from "lucide-react";
import type { FileEntry } from "@agent/shared";

import { useFileList } from "@/components/FileBrowser/useFileList";
import { FileIconTile } from "@/components/FileBrowser/fileIcons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatFileSize } from "@agent/shared";
import { cn } from "@/lib/utils";

interface AssetLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (paths: string[]) => Promise<void> | void;
  disabled?: boolean;
}

function parentPath(path: string): string | null {
  if (path === "assets") return null;
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "assets";
}

export function AssetLibraryDialog({
  open,
  onOpenChange,
  onConfirm,
  disabled,
}: AssetLibraryDialogProps) {
  const [path, setPath] = useState("assets");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const { entries, loading, error, refresh } = useFileList(path);
  const selectedCount = selected.size;

  const breadcrumbs = useMemo(() => {
    const parts = path.split("/");
    return parts.map((part, index) => ({
      label: index === 0 ? "资料库" : part,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [path]);

  const toggleFile = (entry: FileEntry) => {
    if (entry.isDirectory) {
      setPath(entry.path);
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selectedCount === 0 || submitting || disabled) return;
    setSubmitting(true);
    try {
      await onConfirm([...selected]);
      setSelected(new Set());
      setPath("assets");
      onOpenChange(false);
    } catch {
      // 上传错误由输入框现有的 uploadError 区域统一展示，弹窗保持打开便于重试。
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(760px,calc(100vh-32px))] w-[min(920px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-3xl border p-0 shadow-2xl"
      >
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-48 shrink-0 flex-col border-r bg-muted/20 p-4 md:flex">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-white">
                <FileArchive className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">添加资料</div>
                <div className="text-xs text-muted-foreground">工作区文件</div>
              </div>
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-left text-sm font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
              onClick={() => setPath("assets")}
            >
              <Folder className="size-4" />
              资料库
            </button>
            <p className="mt-auto text-xs leading-5 text-muted-foreground">
              选择 assets 文件夹中的现有文件，添加后会作为本次消息的附件发送。
            </p>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <DialogHeader className="shrink-0 border-b px-5 py-4 pr-14 text-left">
              <DialogTitle>从资料库添加</DialogTitle>
              <DialogDescription>
                可跨文件夹选择多个文件，已选择 {selectedCount} 个
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b px-4 text-sm">
                {parentPath(path) && (
                  <button
                    type="button"
                    className="mr-1 rounded-lg px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setPath(parentPath(path) ?? "assets")}
                  >
                    返回上级
                  </button>
                )}
                {breadcrumbs.map((item, index) => (
                  <div key={item.path} className="flex shrink-0 items-center gap-1">
                    {index > 0 && <ChevronRight className="size-3.5 text-muted-foreground/50" />}
                    <button
                      type="button"
                      className="rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => setPath(item.path)}
                    >
                      {item.label}
                    </button>
                  </div>
                ))}
              </div>

              {loading ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  正在读取资料库...
                </div>
              ) : error ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-sm text-destructive">{error}</p>
                  <Button variant="outline" size="sm" onClick={refresh}>重试</Button>
                </div>
              ) : entries.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                  <Folder className="mb-3 size-10 opacity-30" />
                  <p className="text-sm">这个文件夹是空的</p>
                </div>
              ) : (
                <ScrollArea className="flex-1">
                  <div className="space-y-1 p-3">
                    {entries.map((entry) => {
                      const checked = selected.has(entry.path);
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          className={cn(
                            "flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors",
                            checked ? "border-brand-200 bg-brand-50/70 dark:border-brand-800 dark:bg-brand-950/40" : "hover:bg-accent/60",
                          )}
                          onClick={() => toggleFile(entry)}
                        >
                          {!entry.isDirectory ? (
                            <span
                              className={cn(
                                "flex size-4 shrink-0 items-center justify-center rounded border",
                                checked ? "border-brand-600 bg-brand-600 text-white" : "border-input",
                              )}
                              aria-hidden="true"
                            >
                              {checked ? <Check className="size-3" /> : null}
                            </span>
                          ) : (
                            <span className="size-4" />
                          )}
                          <FileIconTile entry={entry} size="sm" open={false} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{entry.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {entry.isDirectory ? "文件夹" : formatFileSize(entry.size)}
                            </span>
                          </span>
                          {entry.isDirectory ? (
                            <ChevronRight className="size-4 text-muted-foreground/50" />
                          ) : checked ? (
                            <Check className="size-4 text-brand-600" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-4">
              <span className="text-sm text-muted-foreground">已选择 {selectedCount} 个文件</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
                <Button onClick={() => { void handleConfirm(); }} disabled={selectedCount === 0 || submitting || disabled}>
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                  添加 {selectedCount > 0 ? selectedCount : ""} 个文件
                </Button>
              </div>
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
