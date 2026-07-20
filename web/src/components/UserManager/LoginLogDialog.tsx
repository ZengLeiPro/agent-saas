import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/useIsMobile";
import { wgs84ToGcj02 } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { useLoginLogs, useUsers, type LoginLogFilters } from "./hooks";

interface LoginLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filterUsername?: string;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

const EVENT_LABELS: Record<string, string> = {
  login_success: "登录成功",
  login_fail: "登录失败",
  app_foreground: "进入前台",
  app_background: "进入后台",
  page_viewed: "浏览页面",
  chat_message_sent: "发送消息",
  session_opened: "查看会话",
  session_soft_deleted: "移入回收站",
  session_restored: "恢复会话",
  session_permanently_deleted: "永久删除",
  session_renamed: "重命名会话",
  session_forked: "复刻会话",
  session_share_updated: "更新会话分享",
  session_share_revoked: "撤销会话分享",
  group_created: "创建分组",
  group_updated: "更新分组",
  group_deleted: "删除分组",
  group_sessions_added: "分组添加会话",
  group_sessions_removed: "分组移除会话",
  cron_job_created: "创建任务",
  cron_job_updated: "编辑任务",
  cron_job_deleted: "删除任务",
  cron_job_toggled: "启停任务",
  cron_job_triggered: "手动执行",
  user_created: "创建用户",
  user_updated: "编辑用户",
  user_deleted: "删除用户",
  user_avatar_updated: "更换头像",
  user_disabled: "禁用用户",
  user_enabled: "启用用户",
  user_password_changed: "修改密码",
  platform_capability_denied: "平台能力拒绝",
  platform_privileged_action: "平台授权操作",
  platform_user_search: "平台用户检索",
  billing_account_adjusted: "调整积分流水",
  file_previewed: "预览文件",
  file_downloaded: "下载文件",
  file_deleted: "删除文件",
  agent_profile_viewed: "查看主页",
  agent_profile_updated: "编辑资料",
  agent_persona_viewed: "查看人格",
  agent_persona_updated: "编辑人格",
  agent_memory_viewed: "查看记忆",
  agent_memory_updated: "编辑记忆",
  agent_avatar_uploaded: "上传头像",
  agent_avatar_reset: "重置头像",
};

const FAIL_LABELS: Record<string, string> = {
  invalid_credentials: "密码错误",
  rate_limited: "频率限制",
  account_disabled: "账号已禁用",
};

const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  mobile: "Mobile",
  dingtalk: "钉钉",
};

/** 事件类别（用于分组筛选） */
const EVENT_CATEGORIES: { value: string; label: string }[] = [
  { value: "login", label: "登录" },
  { value: "activity", label: "活动" },
  { value: "session", label: "会话操作" },
  { value: "group", label: "分组" },
  { value: "cron", label: "定时任务" },
  { value: "user", label: "用户管理" },
  { value: "file", label: "文件操作" },
  { value: "agent", label: "Agent" },
  { value: "platform", label: "平台运营" },
];

/** 从 session 事件的 detail 中提取 sessionId */
function extractSessionId(detail: string): string | null {
  if (!detail) return null;
  // 格式：sessionId 或 sessionId → newTitle
  const arrowIdx = detail.indexOf(" → ");
  const id = arrowIdx !== -1 ? detail.slice(0, arrowIdx) : detail;
  // 校验是合法的 sessionId（UUID 或 agent-xxx 格式）
  if (/^[0-9a-f-]{20,}$/i.test(id) || id.startsWith("agent-")) return id;
  return null;
}

/** 事件对应的 Badge 颜色 */
function eventBadgeClass(event: string): string {
  if (event === "login_success") return "bg-success/15 text-success border-0";
  if (event === "login_fail")
    return "bg-destructive text-destructive-foreground border-0";
  if (event === "app_foreground") return "bg-link/15 text-link border-0";
  if (event === "app_background")
    return "bg-secondary text-secondary-foreground border-0";
  if (event === "page_viewed") return "bg-link/15 text-link border-0";
  if (event.startsWith("session_"))
    return "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-0";
  if (event.startsWith("group_"))
    return "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400 border-0";
  if (event.startsWith("cron_")) return "bg-warning/15 text-warning border-0";
  if (event.startsWith("user_"))
    return "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-0";
  if (event.startsWith("file_"))
    return "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-0";
  if (event.startsWith("agent_"))
    return "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-0";
  return "border-0";
}

export function LoginLogDialog({
  open,
  onOpenChange,
  filterUsername,
}: LoginLogDialogProps) {
  const isMobile = useIsMobile();
  const { users } = useUsers();

  // username → realName 映射
  const realNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) {
      if (u.realName) map.set(u.username, u.realName);
    }
    return map;
  }, [users]);

  // 排除 admin 用户的筛选列表
  const filterableUsers = useMemo(
    () => users.filter((u) => u.role !== "admin"),
    [users],
  );

  // sessionId → title/preview 查找表（打开时加载一次）
  const [sessionsMap, setSessionsMap] = useState<Map<string, string>>(
    new Map(),
  );
  const [selectedUsernames, setSelectedUsernames] = useState<string[]>(
    filterUsername ? [filterUsername] : [],
  );
  const [category, setCategory] = useState("");
  const [channel, setChannel] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearError, setClearError] = useState("");

  // Build filters object — filterUsername 直接参与计算，避免依赖 selectedUsernames 的异步同步
  const effectiveUsernames = filterUsername
    ? [filterUsername]
    : selectedUsernames;
  const filters: LoginLogFilters = {
    username:
      effectiveUsernames.length > 0
        ? effectiveUsernames.length === 1
          ? effectiveUsernames[0]
          : effectiveUsernames
        : undefined,
    category: category || undefined,
    channel: channel || undefined,
    startTime: startTime ? new Date(startTime).toISOString() : undefined,
    endTime: endTime
      ? new Date(endTime + "T23:59:59.999Z").toISOString()
      : undefined,
  };

  const {
    entries,
    total,
    loading,
    error,
    offset,
    limit,
    refresh,
    nextPage,
    prevPage,
    clearLogs,
  } = useLoginLogs(filters);

  // Sync filterUsername prop
  useEffect(() => {
    setSelectedUsernames(filterUsername ? [filterUsername] : []);
  }, [filterUsername]);

  // Fetch on open or filterUsername change
  useEffect(() => {
    if (open) {
      void refresh();
      // 加载所有用户会话列表用于标题查找（仅获取当前用户可见会话）
      authFetch("/api/sessions?limit=500")
        .then(async (res) => {
          if (!res.ok) return;
          const data = await res.json();
          const map = new Map<string, string>();
          for (const s of data.sessions || []) {
            const title = s.title || s.preview?.slice(0, 40);
            if (title) map.set(s.sessionId, title);
          }
          setSessionsMap(map);
        })
        .catch(() => {});
    }
  }, [open, filterUsername]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleClear = async () => {
    setClearError("");
    try {
      await clearLogs();
      setShowClearConfirm(false);
    } catch (err) {
      setClearError(err instanceof Error ? err.message : "清理失败");
    }
  };

  const showFrom = total > 0 ? offset + 1 : 0;
  const showTo = Math.min(offset + limit, total);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {filterUsername
              ? `${realNameMap.get(filterUsername) || filterUsername} 的操作日志`
              : "操作日志"}
          </DialogTitle>
          <DialogDescription>
            登录、会话浏览、文件操作、任务操作、用户管理全量审计
          </DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-2">
          {!filterUsername && filterableUsers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                className={`inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
                  selectedUsernames.length === 0
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                }`}
                onClick={() => setSelectedUsernames([])}
              >
                全部用户
              </button>
              {filterableUsers.map((u) => {
                const isSelected = selectedUsernames.includes(u.username);
                return (
                  <button
                    key={u.id}
                    type="button"
                    className={`inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                    }`}
                    onClick={() =>
                      setSelectedUsernames(
                        isSelected
                          ? selectedUsernames.filter((n) => n !== u.username)
                          : [...selectedUsernames, u.username],
                      )
                    }
                  >
                    {u.realName || u.username}
                  </button>
                );
              })}
            </div>
          )}
          <Select
            value={category || "all"}
            onValueChange={(v) => setCategory(v === "all" ? "" : v)}
          >
            <SelectTrigger className="h-8 w-28">
              <SelectValue placeholder="全部类别" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类别</SelectItem>
              {EVENT_CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={channel || "all"}
            onValueChange={(v) => setChannel(v === "all" ? "" : v)}
          >
            <SelectTrigger className="h-8 w-28">
              <SelectValue placeholder="全部渠道" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部渠道</SelectItem>
              <SelectItem value="web">Web</SelectItem>
              <SelectItem value="mobile">Mobile</SelectItem>
              <SelectItem value="dingtalk">钉钉</SelectItem>
            </SelectContent>
          </Select>
          {!isMobile && (
            <>
              <Input
                type="date"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="h-8 w-36"
                title="起始日期"
              />
              <Input
                type="date"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="h-8 w-36"
                title="结束日期"
              />
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={handleSearch}
          >
            <Search className="size-3.5" />
            搜索
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中...
            </div>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无活动记录
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件</TableHead>
                  {!filterUsername && <TableHead>用户</TableHead>}
                  <TableHead className="hidden sm:table-cell">渠道</TableHead>
                  <TableHead className="hidden sm:table-cell">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, i) => (
                  <TableRow key={`${entry.timestamp}-${i}`}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatTime(entry.timestamp)}
                    </TableCell>
                    <TableCell>
                      <Badge className={eventBadgeClass(entry.event)}>
                        {EVENT_LABELS[entry.event] || entry.event}
                      </Badge>
                    </TableCell>
                    {!filterUsername && (
                      <TableCell className="text-sm">
                        {realNameMap.get(entry.username) || entry.username}
                      </TableCell>
                    )}
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="secondary" className="text-xs">
                        {CHANNEL_LABELS[entry.channel] || entry.channel}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="hidden max-w-48 truncate text-xs text-muted-foreground sm:table-cell"
                      title={entry.detail || ""}
                    >
                      {entry.detail && entry.event.startsWith("session_")
                        ? (() => {
                            const sid = extractSessionId(entry.detail);
                            if (!sid) return entry.detail;
                            const title = sessionsMap.get(sid) || "";
                            const shortId = sid.slice(0, 8);
                            const label = title
                              ? `${shortId} ${title}`
                              : shortId;
                            return (
                              <a
                                href={`/chat/${encodeURIComponent(sid)}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  onOpenChange(false);
                                  window.history.pushState(
                                    null,
                                    "",
                                    `/chat/${encodeURIComponent(sid)}`,
                                  );
                                  window.dispatchEvent(
                                    new PopStateEvent("popstate"),
                                  );
                                }}
                                className="cursor-pointer font-mono text-link hover:underline"
                                title={`${sid}${title ? "\n" + title : ""}`}
                              >
                                {label}
                              </a>
                            );
                          })()
                        : entry.detail
                          ? entry.detail
                          : entry.failReason
                            ? FAIL_LABELS[entry.failReason] || entry.failReason
                            : entry.location
                              ? (() => {
                                  const gcj = wgs84ToGcj02(
                                    entry.location!.longitude,
                                    entry.location!.latitude,
                                  );
                                  return (
                                    <a
                                      href={`https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="font-mono text-link hover:underline"
                                      title="在高德地图中查看（已从 WGS-84 转换为 GCJ-02）"
                                    >
                                      {entry.location!.latitude.toFixed(4)},{" "}
                                      {entry.location!.longitude.toFixed(4)}
                                    </a>
                                  );
                                })()
                              : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Pagination + Clear */}
        <div className="flex items-center justify-between border-t pt-3">
          <div>
            {!showClearConfirm ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setShowClearConfirm(true)}
              >
                <Trash2 className="size-3.5" />
                清理日志
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-destructive">
                  确认清空全部日志？
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleClear}
                >
                  确认
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setShowClearConfirm(false);
                    setClearError("");
                  }}
                >
                  取消
                </Button>
                {clearError && (
                  <span className="text-xs text-destructive">{clearError}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {total > 0 ? `${showFrom}-${showTo} / ${total}` : "无记录"}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              disabled={offset === 0 || loading}
              onClick={prevPage}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              disabled={offset + limit >= total || loading}
              onClick={nextPage}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
