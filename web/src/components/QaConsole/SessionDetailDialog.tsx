import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChatTabContent } from '@/components/chat/ChatTabContent';
import { FilePreviewDialog } from '@/components/FilePreviewPanel';
import { FilePreviewProvider } from '@/contexts/FilePreviewContext';
import { mapSessionDetailToMessages, type ApiSessionDetail } from '@/lib/sessionsApi';
import { authFetch } from '@/lib/authFetch';
import { isKbPath } from '@agent/shared';
import type { QaSessionItem } from './types';

/**
 * 质检台会话详情（复用 ChatTabContent readOnly + mapSessionDetailToMessages，仿 SessionSharePage）
 *
 * 外层挂本地 FilePreviewProvider：kb:// 路径（引用卡）弹 FilePreviewDialog 预览；
 * workspace 文件路径 no-op（file API owner 403 现实约束——admin 读不了他人工作区文件，
 * FILE 卡降级为不可点）。
 */
export function SessionDetailDialog({
  session,
  onClose,
}: {
  session: QaSessionItem | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ApiSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(false);

  const sessionId = session?.sessionId ?? null;

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      setError(null);
      setPreviewFilePath(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setError(null);
    authFetch(`/api/admin/qa/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data = await res.json() as ApiSessionDetail;
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const messages = useMemo(() => {
    if (!detail) return [];
    return mapSessionDetailToMessages(detail, detail.owner?.username);
  }, [detail]);

  const title = session
    ? `${session.title || '未命名会话'} · ${session.username || session.userId || ''}`
    : '';

  return (
    <Dialog open={!!session} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex h-[min(860px,calc(100vh-64px))] w-[min(980px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 pr-16">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium leading-5">{title}</DialogTitle>
            {session?.orgAgentName ? (
              <div className="truncate text-xs text-muted-foreground">
                {session.orgAgentAvatar ? `${session.orgAgentAvatar} ` : ''}{session.orgAgentName}
              </div>
            ) : null}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-secondary/40">
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />加载会话记录...
            </div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center px-6 text-sm text-destructive">{error}</div>
          ) : (
            <FilePreviewProvider
              value={{
                // kb:// 引用卡可预览；workspace 文件路径 no-op（admin 无他人工作区读权限）
                openPreview: (filePath) => { if (isKbPath(filePath)) setPreviewFilePath(filePath); },
              }}
            >
              <ChatTabContent
                messages={messages}
                loading={false}
                isLoadingMessages={false}
                lastMessageRef={lastMessageRef}
                scrollContainerRef={scrollContainerRef}
                isNearBottomRef={isNearBottomRef}
                uploadedFiles={[]}
                onRemoveFile={() => undefined}
                input=""
                uploading={false}
                uploadError={null}
                onInputChange={() => undefined}
                onSend={() => undefined}
                onFileSelect={() => undefined}
                readOnly
                readOnlyInputPlaceholder="质检台只读视图"
                debugModeOverride={false}
                agentProfile={null}
                sessionParticipants={detail?.owner ? { owner: detail.owner, agent: null } : null}
              />
            </FilePreviewProvider>
          )}
        </div>
        <FilePreviewDialog
          open={!!previewFilePath}
          filePath={previewFilePath}
          onClose={() => setPreviewFilePath(null)}
        />
      </DialogContent>
    </Dialog>
  );
}
