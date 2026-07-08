import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Share2 } from "lucide-react";

import { ChatTabContent } from "@/components/chat/ChatTabContent";
import { Badge } from "@/components/ui/badge";
import { FilePreviewProvider } from "@/contexts/FilePreviewContext";
import { fetchPublicSessionShare, type PublicSessionShareResponse } from "@/lib/sessionShareApi";
import { mapSessionDetailToMessages } from "@/lib/sessionsApi";

interface SessionSharePageProps {
  token: string;
}

export function SessionSharePage({ token }: SessionSharePageProps) {
  const [data, setData] = useState<PublicSessionShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPublicSessionShare(token)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const messages = useMemo(() => {
    if (!data) return [];
    return mapSessionDetailToMessages(data.detail, data.detail.owner?.username);
  }, [data]);

  const title = data?.detail.owner?.realName || data?.detail.owner?.username || "会话分享";

  if (loading && !data) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-secondary">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载分享会话...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-secondary px-4">
        <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Share2 className="h-5 w-5" />
          </div>
          <div className="text-base font-semibold">分享链接不可用</div>
          <div className="mt-2 text-sm text-muted-foreground">{error || "分享链接不存在或已失效"}</div>
        </div>
      </div>
    );
  }

  return (
    <FilePreviewProvider value={{
      openPreview: (filePath) => {
        window.open(`/api/share/sessions/${encodeURIComponent(token)}/file?path=${encodeURIComponent(filePath)}`, "_blank", "noopener,noreferrer");
      },
      shareToken: token,
      ...(data.detail.owner?.username ? { owner: data.detail.owner.username } : {}),
    }}>
      <div className="flex h-full min-h-screen flex-col bg-secondary">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-base font-semibold">{title}</div>
            <Badge variant="secondary" className="shrink-0">
              只读分享
            </Badge>
          </div>
          <div className="hidden shrink-0 text-xs text-muted-foreground sm:block">
            {data.share.debugMode ? "调试模式已开启" : "调试模式已关闭"}
          </div>
        </header>

        <ChatTabContent
          messages={messages}
          loading={false}
          isLoadingMessages={loading}
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
          readOnlyInputPlaceholder="只读状态无法发送消息"
          debugModeOverride={data.share.debugMode}
          agentProfile={null}
          sessionParticipants={data.detail.owner ? { owner: data.detail.owner, agent: null } : null}
        />
      </div>
    </FilePreviewProvider>
  );
}
