import { useCallback, useEffect, useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminErrorAlert, EmptyState, EntityLink, MetricCard } from "@/components/PlatformAdmin/common";
import { formatChannel } from "@/components/PlatformAdmin/displayText";
import { useLoginLogs, useUsers, type LoginLogFilters } from "@/components/UserManager/hooks";
import type { LoginLogEntry } from "@/components/UserManager/types";
import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useTenants } from "@/components/TenantManager/hooks";
import { HISTORY_PUSH, HISTORY_PUSH_MERGED, useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";

const AUDIT_EVENT_LABELS: Record<string, string> = {
  login_success: "登录成功",
  login_fail: "登录失败",
  app_foreground: "进入前台",
  app_background: "进入后台",
  page_viewed: "浏览页面",
  chat_message_sent: "发送消息",
  session_opened: "查看对话",
  session_soft_deleted: "移入回收站",
  session_restored: "恢复对话",
  session_permanently_deleted: "永久删除",
  session_renamed: "重命名对话",
  session_forked: "复刻对话",
  session_share_updated: "更新对话分享",
  session_share_revoked: "撤销对话分享",
  group_created: "创建分组",
  group_updated: "更新分组",
  group_deleted: "删除分组",
  group_sessions_added: "分组添加对话",
  group_sessions_removed: "分组移除对话",
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
  user_phone_updated: "更新手机号",
  user_phone_verified: "验证手机号",
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
  tenant_created: "创建组织",
  tenant_updated: "更新组织",
  tenant_disabled: "禁用组织",
  tenant_enabled: "启用组织",
  tenant_deleted: "删除组织",
  mcp_user_selections_updated: "更新 MCP 选择",
  mcp_secret_bound: "绑定 MCP 密钥",
  mcp_server_updated: "更新 MCP 服务",
  mcp_server_deleted: "删除 MCP 服务",
  mcp_admin_user_selections_updated: "管理员更新 MCP",
  mcp_oauth_connected: "连接器账号授权",
  mcp_oauth_revoked: "断开连接器账号",
  skill_custom_uploaded: "上传自定义技能",
  skill_tenant_uploaded: "上传组织技能",
  skill_pool_uploaded: "上传平台技能",
  skill_document_updated: "更新技能文档",
  skill_visibility_updated: "更新技能可见性",
  skill_platform_settings_updated: "更新平台技能设置",
  skill_tenant_selections_updated: "更新组织技能选择",
  skill_tenant_settings_updated: "更新组织技能设置",
  skill_tenant_own_settings_updated: "更新组织自有技能设置",
  skill_tenant_deleted: "删除组织技能",
  skill_promoted: "发布技能",
  skill_promoted_to_tenant: "发布到组织技能",
  skill_custom_deleted: "删除自定义技能",
  skill_user_selections_updated: "更新技能选择",
  platform_capability_denied: "平台能力拒绝",
  platform_privileged_action: "平台授权操作",
  platform_user_search: "平台用户检索",
  billing_account_adjusted: "调整积分流水",
};

const auditCategories: AdminSelectOption[] = [
  { value: "", label: "全部事件" },
  { value: "login", label: "登录" },
  { value: "platform", label: "平台运营" },
  { value: "activity", label: "活动" },
  { value: "session", label: "对话" },
  { value: "group", label: "分组" },
  { value: "cron", label: "定时任务" },
  { value: "user", label: "用户管理" },
  { value: "file", label: "文件" },
  { value: "agent", label: "AI 助手" },
  { value: "skill", label: "技能" },
  { value: "mcp", label: "连接器" },
  { value: "tenant", label: "组织" },
];

const auditChannels: AdminSelectOption[] = [
  { value: "", label: "全部渠道" },
  { value: "web", label: "Web 端" },
  { value: "mobile", label: "移动端" },
  { value: "dingtalk", label: "钉钉" },
];

function formatAuditTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
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

function shanghaiDateBoundary(date: string, endOfDay = false): string | undefined {
  if (!date) return undefined;
  const localTime = endOfDay ? "23:59:59.999" : "00:00:00.000";
  return new Date(`${date}T${localTime}+08:00`).toISOString();
}

function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] || "其他操作";
}

function auditEventBadgeClass(event: string): string {
  if (event === "login_fail") return "bg-destructive text-destructive-foreground border-0";
  if (event === "login_success") return "bg-success/15 text-success-ink border-0";
  if (event.startsWith("tenant_")) return "bg-chart-1/15 border-0";
  if (event.startsWith("user_")) return "bg-chart-2/15 border-0";
  if (event.startsWith("mcp_")) return "bg-chart-4/15 border-0";
  if (event.startsWith("skill_")) return "bg-chart-3/15 border-0";
  if (event.startsWith("file_")) return "bg-chart-5/15 border-0";
  if (event.startsWith("cron_")) return "bg-warning/15 text-warning-ink border-0";
  return "bg-muted text-muted-foreground border-0";
}

export function AuditEventsPanel({
  scope,
  tenantId,
  tenantName,
}: {
  scope: "tenant" | "platform";
  tenantId?: string;
  tenantName?: string;
}) {
  const { users } = useUsers();
  const { tenants } = useTenants();
  // URL 同步：`audit*` 命名空间前缀（同 ToolAnalysisPanel 的 `tool*` 方案），避免与宿主页 key 冲突。
  // 参数名一律取业务可读词（auditType / auditOrg / auditFrom），不暴露内部字段名——
  // 本面板同时服务平台运维与组织管理员，客户看得见地址栏。
  const url = useAdminUrlQuery();
  const category = url.get("auditType") ?? "";
  const channel = url.get("auditChannel") ?? "";
  const usernameFilter = url.get("auditUser") ?? "";
  const tenantIdFilter = url.get("auditOrg") ?? "";
  const startDate = url.get("auditFrom") ?? "";
  const endDate = url.get("auditTo") ?? "";
  const setCategory = useCallback((value: string) => url.set("auditType", value || null, HISTORY_PUSH), [url]);
  const setChannel = useCallback((value: string) => url.set("auditChannel", value || null, HISTORY_PUSH), [url]);
  const setTenantIdFilter = useCallback((value: string) => url.set("auditOrg", value || null, HISTORY_PUSH), [url]);
  // 文本 / 日期输入：500ms 合并，否则每敲一个字符一条历史记录
  const setUsernameFilter = useCallback((value: string) => url.set("auditUser", value || null, HISTORY_PUSH_MERGED), [url]);
  const setStartDate = useCallback((value: string) => url.set("auditFrom", value || null, HISTORY_PUSH_MERGED), [url]);
  const setEndDate = useCallback((value: string) => url.set("auditTo", value || null, HISTORY_PUSH_MERGED), [url]);

  const tenantUsers = useMemo(
    () => tenantId ? users.filter(user => user.tenantId === tenantId) : users,
    [tenantId, users],
  );
  const tenantUsernames = useMemo(() => tenantUsers.map(user => user.username), [tenantUsers]);
  const tenantFilterOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: "全部组织" },
    ...tenants.map(item => ({ value: item.id, label: item.name })),
  ], [tenants]);
  const filters: LoginLogFilters = useMemo(() => ({
    username: usernameFilter.trim() || (scope === "tenant" ? (tenantUsernames.length > 0 ? tenantUsernames : ["__empty_tenant__"]) : undefined),
    tenantId: scope === "tenant" ? tenantId : tenantIdFilter.trim() || undefined,
    category: category || undefined,
    channel: channel || undefined,
    startTime: shanghaiDateBoundary(startDate),
    endTime: shanghaiDateBoundary(endDate, true),
  }), [category, channel, endDate, scope, startDate, tenantId, tenantIdFilter, tenantUsernames, usernameFilter]);

  const { entries, total, loading, error, offset, limit, refresh, nextPage, prevPage } = useLoginLogs(filters);

  // 空态要能分辨「真的没有」和「被筛没了」，后者必须给一条退路。
  // scope=tenant 时组织是上下文而非用户选的筛选，不算在内。
  const hasAuditFilters = Boolean(
    category || channel || usernameFilter.trim() || startDate || endDate
    || (scope === "platform" && tenantIdFilter.trim()),
  );
  const clearAuditFilters = useCallback(() => {
    url.patch({
      auditType: null,
      auditChannel: null,
      auditUser: null,
      auditOrg: null,
      auditFrom: null,
      auditTo: null,
    }, HISTORY_PUSH);
  }, [url]);
  const userMap = useMemo(() => new Map(users.map(user => [user.username, user])), [users]);
  const uniqueActors = useMemo(() => new Set(entries.map(entry => entry.username)).size, [entries]);
  const failures = entries.filter(entry => entry.event === "login_fail").length;
  const adminOps = entries.filter(entry => entry.event.includes("_") && !["login_success", "login_fail", "page_viewed", "app_foreground", "app_background"].includes(entry.event)).length;

  useEffect(() => { void refresh(); }, [refresh]);

  const emptyTenant = scope === "tenant" && tenantUsernames.length === 0;

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title={scope === "tenant" ? "组织操作记录" : "平台操作记录"}
        description={scope === "tenant"
          ? `查看 ${tenantName || tenantId || "当前组织"} 的登录、成员、文件、工具和配置变更记录。`
          : "查看跨组织的登录、用户、工具、技能、文件和执行环境变更。"}
        actions={<Button variant="outline" onClick={() => { void refresh(); }} disabled={loading}><RefreshCw className={cn("mr-2 size-4", loading && "animate-spin")} />刷新</Button>}
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="事件总数" value={total} description="符合当前筛选条件" />
        <MetricCard title="当前页操作者" value={uniqueActors} description="本页涉及账号数" />
        <MetricCard title="失败登录" value={failures} description="本页登录失败事件" />
        <MetricCard title="管理操作" value={adminOps} description="本页配置/资源变更" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">筛选条件</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-7">
          <div className="space-y-1.5">
            <Label>事件类别</Label>
            <AdminSelect ariaLabel="事件类别" size="md" className="w-full" options={auditCategories} value={category} onValueChange={setCategory} />
          </div>
          <div className="space-y-1.5">
            <Label>渠道</Label>
            <AdminSelect ariaLabel="渠道" size="md" className="w-full" options={auditChannels} value={channel} onValueChange={setChannel} />
          </div>
          <div className="space-y-1.5">
            <Label>用户名</Label>
            <Input value={usernameFilter} onChange={event => setUsernameFilter(event.target.value)} placeholder="用户名" />
          </div>
          <div className="space-y-1.5">
            <Label>组织</Label>
            <AdminSelect
              ariaLabel="组织"
              size="md"
              className="w-full"
              options={tenantFilterOptions}
              value={scope === "tenant" ? tenantId || "" : tenantIdFilter}
              onValueChange={setTenantIdFilter}
              disabled={scope === "tenant"}
            />
          </div>
          <div className="space-y-1.5">
            <Label>开始日期</Label>
            <Input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>结束日期</Label>
            <Input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} />
          </div>
          <div className="flex items-end">
            <Button className="w-full" onClick={() => { void refresh(); }} disabled={loading || emptyTenant}>查询</Button>
          </div>
        </CardContent>
      </Card>

      {error && <AdminErrorAlert error={error} />}
      {emptyTenant && <div className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">当前组织暂无成员，审计列表为空。</div>}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">事件列表</CardTitle>
          <div className="text-xs text-muted-foreground">第 {Math.floor(offset / limit) + 1} 页 · {offset + 1}-{Math.min(offset + entries.length, total)} / {total}</div>
        </CardHeader>
        <CardContent className="p-0">
          {/*
            用 `loading && entries.length === 0` 而不是 `loading`：翻页或改筛选时
            旧数据仍留在屏上，只由头部刷新图标转圈表示在拉新数据。改造前是无条件
            替换整表，每次刷新都会闪一下空白，与 AdminEntityTable 的行为也不一致。
          */}
          {loading && entries.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />正在加载操作记录…
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              compact
              icon={EntityIcons.audit}
              title={hasAuditFilters ? "当前筛选条件下没有操作记录" : "暂无操作记录"}
              description={hasAuditFilters
                ? "换个事件类型、成员或放宽日期范围再看看。"
                : "成员在平台上的关键操作会记录在这里。"}
              action={hasAuditFilters ? { label: "清除筛选", onClick: clearAuditFilters } : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>组织</TableHead>
                  <TableHead>渠道/IP</TableHead>
                  <TableHead>详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry: LoginLogEntry, index) => {
                  const actor = userMap.get(entry.username);
                  const rowTenantId = entry.tenantId || actor?.tenantId || (scope === "tenant" ? tenantId : undefined);
                  return (
                    <TableRow key={`${entry.timestamp}-${entry.username}-${entry.event}-${index}`}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatAuditTime(entry.timestamp)}</TableCell>
                      <TableCell><Badge className={auditEventBadgeClass(entry.event)} title={entry.event}>{auditEventLabel(entry.event)}</Badge></TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {actor ? (
                            <EntityLink kind="user" id={actor.id} label={actor.realName || entry.username} tenantId={actor.tenantId} />
                          ) : entry.username}
                        </div>
                        <div className="text-xs text-muted-foreground">{entry.username}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground"><EntityLink kind="tenant" id={rowTenantId} /></TableCell>
                      <TableCell>
                        <div className="text-xs">{formatChannel(entry.channel)}</div>
                        <div className="text-xs text-muted-foreground">{entry.ip || "-"}</div>
                      </TableCell>
                      <TableCell className="max-w-sm truncate text-xs text-muted-foreground" title={entry.detail || entry.failReason || ""}>{entry.detail || entry.failReason || "-"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={prevPage} disabled={loading || offset === 0}>上一页</Button>
        <Button variant="outline" size="sm" onClick={nextPage} disabled={loading || offset + limit >= total}>下一页</Button>
      </div>
    </div>
  );
}

