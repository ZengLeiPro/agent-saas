export const RUN_LABEL = "运行记录";
export const RUN_SHORT_LABEL = "运行";
export const RUN_TRACE_LABEL = "运行追踪";
export const SANDBOX_LABEL = "执行环境";
export const WORKSPACE_LABEL = "工作区";

export const RUN_STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  idle: "空闲",
  pending: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  waiting_user: "等待用户",
  waiting_hand: "等待执行环境",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  orphaned: "孤儿态",
};

export const SANDBOX_PHASE_LABELS: Record<string, string> = {
  Running: "运行中",
  Paused: "已暂停",
  Pending: "创建中",
  Provisioning: "配置中",
  Failed: "异常",
  Unknown: "未知",
};

export const ENTITY_KIND_LABELS: Record<string, string> = {
  run: RUN_SHORT_LABEL,
  session: "会话",
  user: "用户",
  tenant: "租户",
  sandbox: SANDBOX_LABEL,
  workspace: WORKSPACE_LABEL,
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "管理员",
  user: "普通用户",
};

export const SESSION_KIND_LABELS: Record<string, string> = {
  user: "用户会话",
  subagent: "子 Agent",
};

export const CHANNEL_LABELS: Record<string, string> = {
  web: "Web 端",
  mobile: "移动端",
  dingtalk: "钉钉",
  cron: "定时任务",
  api: "API",
  subagent: "子 Agent",
  title: "标题生成",
  embedding: "向量化",
  both: "钉钉 + Web 端",
  ding_work_notification: "钉钉工作通知",
  ding_group: "钉钉群",
  ding_both: "钉钉工作通知 + 群",
};

export const HEALTH_STATUS_LABELS: Record<string, string> = {
  ok: "正常",
  unhealthy: "异常",
  unknown: "未知",
};

export const ATTENTION_KIND_LABELS: Record<string, string> = {
  failed_run: "运行失败",
  stale_run: "运行卡住",
  broken_sandbox: "执行环境异常",
  transient_sandbox: "执行环境卡住",
  hand_failure: "执行环境故障",
  disk_root_high: "根盘水位高",
  workspace_scan_stale: "工作区扫描过期",
  orphan_workspace: "孤儿工作区",
  tls_cert_expiring: "证书即将过期",
  cost_daily_high: "单日成本过高",
};

export const WORKSPACE_STATUS_LABELS: Record<string, string> = {
  active: "活跃",
  soft_deleted: "软删残留",
  orphan_tenant: "孤儿组织",
  orphan_user: "孤儿用户",
};

export const EXECUTION_TARGET_LABELS: Record<string, string> = {
  "server-local": "服务端本机",
  "server-container": "隔离执行环境",
  "server-remote": "远端执行环境",
  client: "客户端执行环境",
};

export const TOOL_RISK_LABELS: Record<string, string> = {
  safe: "安全",
  workspace_write: "工作区写入",
  dangerous: "高风险",
  read_only: "只读",
  external_write: "外部写入",
  credentialed_external_write: "带凭据外部写入",
};

export const FAILURE_CLASS_LABELS: Record<string, string> = {
  auth: "认证异常",
  timeout: "超时",
  network: "网络异常",
  unhealthy: "健康异常",
  unknown: "未分类",
};

export function displayText(map: Record<string, string>, value: string | null | undefined, fallback = "未知"): string {
  if (!value) return fallback;
  return map[value] ?? value;
}

export function formatRunStatus(status: string | null | undefined): string {
  return displayText(RUN_STATUS_LABELS, status);
}

export function formatSandboxPhase(status: string | null | undefined): string {
  return displayText(SANDBOX_PHASE_LABELS, status);
}

export function formatEntityKind(kind: string | null | undefined): string {
  return displayText(ENTITY_KIND_LABELS, kind);
}

export function formatRole(role: string | null | undefined): string {
  return displayText(ROLE_LABELS, role, "未知角色");
}

export function formatSessionKind(kind: string | null | undefined): string {
  return displayText(SESSION_KIND_LABELS, kind, "未知类型");
}

export function formatSessionStatus(status: string | null | undefined): string {
  return displayText(RUN_STATUS_LABELS, status ?? "active");
}

export function formatChannel(channel: string | null | undefined): string {
  return displayText(CHANNEL_LABELS, channel, "未知渠道");
}

export function formatHealthStatus(status: string | null | undefined): string {
  return displayText(HEALTH_STATUS_LABELS, status);
}

export function formatSystemOwner(kind: string | null | undefined): string {
  if (kind === "system" || !kind) return "系统";
  return displayText(SESSION_KIND_LABELS, kind);
}

export function formatBusyState(busy: boolean | null | undefined): string {
  if (busy == null) return "未知";
  return busy ? "忙碌" : "空闲";
}

export function formatImageFreshness(stale: boolean | null | undefined): string {
  if (stale == null) return "未知";
  return stale ? "镜像过期" : "当前版本";
}

export function formatLifecycleState(enabled: boolean | null | undefined): string {
  if (enabled == null) return "未知";
  return enabled ? "已启用" : "未启用";
}

export function formatManagedState(managed: boolean | null | undefined): string {
  if (managed == null) return "未知";
  return managed ? "平台托管" : "外部项";
}

export function formatAttentionKind(kind: string | null | undefined): string {
  return displayText(ATTENTION_KIND_LABELS, kind, "异常");
}

export function formatExecutionTarget(target: string | null | undefined): string {
  return displayText(EXECUTION_TARGET_LABELS, target, "未知执行目标");
}

export function formatToolRisk(risk: string | null | undefined): string {
  return displayText(TOOL_RISK_LABELS, risk, "未知风险");
}

export function formatFailureClass(value: string | null | undefined): string {
  return displayText(FAILURE_CLASS_LABELS, value, "未分类");
}

export function formatAttentionTitle(item: { kind?: string; title?: string }): string {
  const title = item.title ?? "";
  switch (item.kind) {
    case "failed_run":
      return title.startsWith("Run failed: ")
        ? `运行失败：${title.slice("Run failed: ".length)}`
        : title || "运行失败";
    case "stale_run": {
      const match = /^Stale (.+) run$/.exec(title);
      return match ? `${formatRunStatus(match[1])}的运行记录长期未变化` : title || "运行卡住";
    }
    case "transient_sandbox": {
      const match = /^Sandbox stuck in (.+)$/.exec(title);
      return match ? `执行环境卡在${formatSandboxPhase(match[1])}` : title || "执行环境卡住";
    }
    case "hand_failure":
      return title && title !== "hand_failure" ? title : "执行环境故障";
    default:
      return title || formatAttentionKind(item.kind);
  }
}

export function formatWorkspaceStatus(status: string | null | undefined): string {
  return displayText(WORKSPACE_STATUS_LABELS, status, "未知");
}
