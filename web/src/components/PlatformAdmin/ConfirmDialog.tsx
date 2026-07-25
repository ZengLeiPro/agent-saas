import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ConfirmDetail {
  label: string;
  value: ReactNode;
}

export interface ConfirmRequest {
  title: string;
  /** 一句话说清「会发生什么」，不是复述按钮名 */
  description?: ReactNode;
  /** 影响面清单（大小 / 文件数 / 路径…）。原生 confirm 只能塞 \n，这里能对齐排版 */
  details?: ConfirmDetail[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /**
   * 危险操作的二次保护：必须逐字输入该文本才能确认。
   * 替代原来的 `window.prompt`——**保护强度不降**：仍然要求手打目录名，
   * 只是从「两个连续系统弹窗」变成「一个带影响面清单的对话框」。
   */
  requireText?: string;
  /** 输入框上方的说明，默认「输入 {requireText} 以确认」 */
  requireTextLabel?: ReactNode;
  onConfirm: () => void;
}

/**
 * platform-admin 的应用内确认对话框。
 *
 * 为什么必须换掉 `window.confirm` / `window.prompt`（改造前 8 + 2 处）：
 * 1. 原生弹窗**阻塞主线程**，且在 iOS Safari / PWA 里样式与站点完全脱节；
 * 2. 无法排版影响面（原生只能靠 `\n`），运维在删目录前看不清「多大、几个文件」；
 * 3. 无法区分「破坏性」与「例行」操作——两者长得一模一样；
 * 4. 不可测（jsdom 里必须 stub `window.confirm`，等于没测过真实动线）。
 *
 * 用法：
 * ```tsx
 * const { confirm, confirmDialog } = useConfirmDialog();
 * <Button onClick={() => confirm({ title: "暂停执行环境？", onConfirm: doPause })} />
 * {confirmDialog}
 * ```
 */
export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [typed, setTyped] = useState("");
  // onConfirm 放在 ref 里，避免 Dialog 关闭动画期间 state 被清掉后回调丢失
  const pending = useRef<ConfirmRequest | null>(null);

  const confirm = useCallback((next: ConfirmRequest) => {
    pending.current = next;
    setTyped("");
    setRequest(next);
  }, []);

  const close = useCallback(() => {
    pending.current = null;
    setRequest(null);
    setTyped("");
  }, []);

  const satisfied = !request?.requireText || typed === request.requireText;

  const accept = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    if (current.requireText && typed !== current.requireText) return;
    close();
    current.onConfirm();
  }, [close, typed]);

  const confirmDialog = useMemo(() => (
    <Dialog
      open={request != null}
      onOpenChange={(open) => { if (!open) close(); }}
    >
      {request && (
        <DialogContent className="max-w-md gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {request.tone === "danger" && <TriangleAlert className="size-4 shrink-0 text-destructive" />}
              {request.title}
            </DialogTitle>
            {/*
              描述始终渲染：没传 description 时用 sr-only 兜底。
              不这么做的话，Radix 会对「无 DialogDescription」告警，而且屏幕阅读器
              用户只听得到标题——在「永久删除目录」这种场合，听不出会动什么。
            */}
            {request.description ? (
              <DialogDescription className="text-xs leading-relaxed">{request.description}</DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                {request.tone === "danger" ? "这是不可恢复的操作，请确认影响面后继续。" : "请确认后继续。"}
              </DialogDescription>
            )}
          </DialogHeader>

          {request.details && request.details.length > 0 && (
            <dl className="space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs">
              {request.details.map((detail) => (
                <div key={detail.label} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">{detail.label}</dt>
                  <dd className="min-w-0 break-all text-right font-mono tabular-nums">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {request.requireText && (
            <div className="space-y-1.5">
              <label className="block text-xs text-muted-foreground" htmlFor="admin-confirm-text">
                {request.requireTextLabel ?? <>输入 <code className="rounded bg-muted px-1 font-mono text-foreground">{request.requireText}</code> 以确认</>}
              </label>
              <Input
                id="admin-confirm-text"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  accept();
                }}
                className="h-8 font-mono text-xs"
                placeholder={request.requireText}
              />
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" size="sm" onClick={close}>
              {request.cancelLabel ?? "取消"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={request.tone === "danger" ? "destructive" : "default"}
              disabled={!satisfied}
              onClick={accept}
              className={cn(!satisfied && "cursor-not-allowed")}
            >
              {request.confirmLabel ?? "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  ), [accept, close, request, satisfied, typed]);

  return { confirm, confirmDialog };
}
