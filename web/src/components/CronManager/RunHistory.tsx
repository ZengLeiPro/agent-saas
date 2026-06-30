import type { CronRunLogEntry } from "./types";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Copy, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { cn } from "@/lib/utils";
import { parseJsonResponse } from "@agent/shared";

type RunLogBlockKind =
  | "prompt"
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "meta";

type RunLogBlock = {
  id: string;
  tsMs?: number;
  kind: RunLogBlockKind;
  title: string;
  defaultOpen: boolean;
  content: string;
  raw?: string;
  isError?: boolean;
};

type RunDetailsResponse = {
  run: CronRunLogEntry & { hasTranscript?: boolean };
  transcript: { sessionId?: string; stats?: { lines: number; parsedLines: number; parseErrors: number } };
  blocks: RunLogBlock[];
};

interface RunHistoryProps {
  entries: CronRunLogEntry[];
  loading: boolean;
  error?: string | null;
}

export function RunHistory({ entries, loading, error }: RunHistoryProps) {
  const { user } = useAuth();
  // 仅当用户开启 debug 模式时，才允许点击行查看完整运行详情；否则只能看到这个列表。
  const debugMode = user?.debugMode === true;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<CronRunLogEntry | null>(null);
  const [details, setDetails] = useState<RunDetailsResponse | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showTools, setShowTools] = useState(true);
  const [showMeta, setShowMeta] = useState(true);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!dialogOpen || !selected) return;

    setDetails(null);
    setDetailsError(null);

    // status='error' 的 run 没有走完 agent loop，不会产生 transcript。直接展示
    // entry.error 即可，跳过 details 请求避免拉回 409 "transcript 找不到"误导。
    if (selected.status === "error") {
      setDetailsLoading(false);
      return;
    }

    setDetailsLoading(true);
    authFetch(`/api/cron/jobs/${selected.jobId}/runs/${selected.runId}/details`)
      .then((res) => parseJsonResponse<RunDetailsResponse>(res, "定时任务"))
      .then((data) => {
        setDetails(data);
        setDetailsError(null);
      })
      .catch((e) => {
        setDetails(null);
        setDetailsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setDetailsLoading(false));
  }, [dialogOpen, selected]);

  useEffect(() => {
    if (!details?.blocks) return;
    const initial = new Set<string>();
    for (const b of details.blocks) {
      if (b.defaultOpen) initial.add(b.id);
    }
    setOpenBlocks(initial);
  }, [details?.blocks]);

  const toolErrorCount = useMemo(() => {
    if (!details?.blocks) return 0;
    return details.blocks.filter((b) => b.isError).length;
  }, [details?.blocks]);

  const filteredBlocks = useMemo(() => {
    if (!details?.blocks) return [];
    const q = query.trim().toLowerCase();
    return details.blocks.filter((b) => {
      if (!showTools && (b.kind === "tool_use" || b.kind === "tool_result")) return false;
      if (!showMeta && b.kind === "meta") return false;
      if (onlyErrors && !b.isError) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        b.kind.toLowerCase().includes(q) ||
        b.content.toLowerCase().includes(q)
      );
    });
  }, [details?.blocks, query, showMeta, showTools, onlyErrors]);

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const statusBadge = (status: CronRunLogEntry["status"]) => {
    if (status === "ok") {
      return <Badge className="bg-primary/15 text-primary hover:bg-primary/15">成功</Badge>;
    }
    if (status === "error") return <Badge variant="destructive">失败</Badge>;
    return <Badge variant="secondary">跳过</Badge>;
  };

  const blockKindBadge = (kind: RunLogBlockKind) => {
    switch (kind) {
      case "prompt":
        return <Badge variant="secondary">Prompt</Badge>;
      case "text":
        return <Badge>Text</Badge>;
      case "thinking":
        return <Badge variant="outline">Thinking</Badge>;
      case "tool_use":
        return <Badge variant="secondary">Tool</Badge>;
      case "tool_result":
        return <Badge variant="secondary">Tool Result</Badge>;
      case "meta":
      default:
        return <Badge variant="outline">Meta</Badge>;
    }
  };

  const previewOf = (content: string, max = 180) => {
    const t = content.trim();
    if (!t) return "";
    if (t.length <= max) return t;
    return `${t.slice(0, max)}…`;
  };

  if (loading) {
    return <div className="py-6 text-center text-sm text-muted-foreground">加载中...</div>;
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (entries.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">暂无运行记录</div>;
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">运行历史</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">时间</TableHead>
            <TableHead className="whitespace-nowrap">状态</TableHead>
            <TableHead className="whitespace-nowrap">耗时</TableHead>
            <TableHead>摘要</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry, i) => (
            <TableRow
              key={i}
              className={cn(
                debugMode ? "cursor-pointer" : "cursor-default hover:bg-transparent",
              )}
              onClick={
                debugMode
                  ? () => {
                      setSelected(entry);
                      setDialogOpen(true);
                    }
                  : undefined
              }
            >
              <TableCell className="whitespace-nowrap">
                {new Date(entry.startedAtMs).toLocaleString("zh-CN")}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {statusBadge(entry.status)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {(entry.durationMs / 1000).toFixed(1)}s
              </TableCell>
              <TableCell className="max-w-[420px] truncate text-muted-foreground">
                {entry.status === "ok"
                  ? "运行成功"
                  : entry.status === "skipped"
                    ? "已跳过"
                    : entry.error
                      ? entry.error.substring(0, 200)
                      : "运行失败"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              运行详情
            </DialogTitle>
            <DialogDescription>
              {selected
                ? `${new Date(selected.startedAtMs).toLocaleString("zh-CN")}（${(
                    selected.durationMs / 1000
                  ).toFixed(1)}s）`
                : " "}
            </DialogDescription>
          </DialogHeader>

          {selected ? (
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(selected.status)}
              {selected.sessionId ? (
                <Badge variant="secondary">session: {selected.sessionId}</Badge>
              ) : null}
              <Badge variant="outline">run: {selected.runId}</Badge>
              {toolErrorCount > 0 ? (
                <Badge variant="destructive">工具错误 {toolErrorCount}</Badge>
              ) : null}
            </div>
          ) : null}

          {detailsError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {detailsError}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <div className="w-full sm:w-[320px]">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索（工具名/关键词/内容）"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-tools"
                checked={showTools}
                onCheckedChange={(v) => setShowTools(!!v)}
              />
              <label htmlFor="show-tools" className="text-sm">
                显示工具
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="only-errors"
                checked={onlyErrors}
                onCheckedChange={(v) => setOnlyErrors(!!v)}
              />
              <label htmlFor="only-errors" className="text-sm">
                只看错误
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-meta"
                checked={showMeta}
                onCheckedChange={(v) => setShowMeta(!!v)}
              />
              <label htmlFor="show-meta" className="text-sm">
                显示 Meta
              </label>
            </div>
            <Button
              variant="outline"
              onClick={() => copyText(filteredBlocks.map((b) => `## ${b.title}\n${b.content}`).join("\n\n"))}
              disabled={!filteredBlocks.length}
            >
              <Copy />
              复制全部
            </Button>
          </div>

          {/* entry.error 独立展示：不依赖 details 加载（status='error' 时 details 不会请求） */}
          {selected?.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-destructive">错误</div>
                <Button variant="outline" size="sm" onClick={() => copyText(selected.error || "")}>
                  <Copy />
                  复制
                </Button>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-destructive">
                {selected.error}
              </pre>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            {detailsLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">加载日志中...</div>
            ) : details ? (
              <ScrollArea className="h-[60vh] pr-3">
                <div className="space-y-3">
                  {details.transcript?.stats ? (
                    <div className="text-xs text-muted-foreground">
                      transcript：{details.transcript.stats.parsedLines}/{details.transcript.stats.lines} 行,
                      解析错误 {details.transcript.stats.parseErrors} 行
                    </div>
                  ) : null}

                  {filteredBlocks.map((b) => (
                    <div
                      key={b.id}
                      className={cn(
                        "rounded-md border bg-card",
                        b.isError && "border-destructive/50 bg-destructive/5"
                      )}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                        onClick={() => {
                          setOpenBlocks((prev) => {
                            const next = new Set(prev);
                            if (next.has(b.id)) next.delete(b.id);
                            else next.add(b.id);
                            return next;
                          });
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {blockKindBadge(b.kind)}
                          {b.isError ? <Badge variant="destructive">ERROR</Badge> : null}
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="min-w-0 truncate text-sm font-medium">
                              {b.title}
                            </div>
                            {b.tsMs ? (
                              <div className="shrink-0 text-xs text-muted-foreground">
                                {new Date(b.tsMs).toLocaleTimeString("zh-CN")}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 transition-transform",
                            openBlocks.has(b.id) && "rotate-180"
                          )}
                        />
                      </button>

                      {openBlocks.has(b.id) ? (
                        <div className="px-3 pb-3">
                          <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => copyText(b.content)}>
                              <Copy />
                              复制
                            </Button>
                            {b.raw ? (
                              <Button variant="outline" size="sm" onClick={() => copyText(b.raw!)}>
                                <Copy />
                                复制原始 JSON
                              </Button>
                            ) : null}
                          </div>

                          <div className="rounded-md bg-muted/30 p-3">
                            <pre className="whitespace-pre-wrap text-xs text-foreground/90">
                              {b.content}
                            </pre>
                          </div>

                          {b.raw ? (
                            <details className="mt-2">
                              <summary className="cursor-pointer select-none text-xs text-muted-foreground">
                                查看原始 JSON
                              </summary>
                              <div className="mt-2 rounded-md bg-muted/20 p-3">
                                <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                                  {b.raw}
                                </pre>
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ) : (
                        <div className="px-3 pb-3 text-xs text-muted-foreground">
                          {previewOf(b.content)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
