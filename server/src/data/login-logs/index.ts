export { appendLoginLog, queryLoginLogs, clearLoginLogs, clearLogsByUsername, getLastActivePerUser } from './store.js';
export type { UserActiveInfo } from './store.js';
export { detectLoginChannel } from './channel.js';
export type { LoginLogEntry, LoginLogQuery, LoginLogResponse, LoginChannel, LoginEvent } from './types.js';

import { appendLoginLog } from './store.js';
import { detectLoginChannel } from './channel.js';
import type { LoginLogEntry, LoginEvent } from './types.js';

/**
 * 审计日志单例 — 初始化后可在任意路由中调用 auditLog()
 */
let _auditLogPath: string | undefined;

export function initAuditLog(filePath: string): void {
  _auditLogPath = filePath;
}

/**
 * Admin 角色仍必须审计的事件集合（δ 阶段新增）。
 *
 * 普通登录/页面浏览等高频活动允许对 admin skip 防止刷屏，但所有"管理动作"
 * （user/skill/cron/group/agent 改动 + 文件删除）必须留痕，否则 admin 行为
 * 完全无审计可查，不符合合规要求。
 *
 * 命名规则：所有 admin 主动改动他人或全局状态的事件都进白名单；以 _updated /
 * _created / _deleted / _changed / _promoted / _disabled / _enabled / _reset /
 * _uploaded / _toggled / _triggered 结尾的事件均强制记录。
 */
const ADMIN_ALWAYS_AUDITED: ReadonlySet<LoginEvent> = new Set<LoginEvent>([
  'user_created', 'user_updated', 'user_deleted', 'user_disabled', 'user_enabled',
  'user_password_changed', 'user_avatar_updated',
  'cron_job_created', 'cron_job_updated', 'cron_job_deleted', 'cron_job_toggled', 'cron_job_triggered',
  'group_created', 'group_updated', 'group_deleted', 'group_sessions_added',
  'group_sessions_removed', 'group_sorting_updated',
  'agent_profile_updated', 'agent_persona_updated', 'agent_memory_updated',
  'agent_avatar_uploaded', 'agent_avatar_reset',
  'skill_visibility_updated', 'skill_platform_settings_updated', 'skill_tenant_settings_updated',
  'skill_promoted', 'skill_custom_deleted', 'skill_tenant_selections_updated',
  'skill_user_selections_updated', 'skill_document_updated',
  'mcp_server_updated', 'mcp_server_deleted', 'mcp_user_selections_updated', 'mcp_admin_user_selections_updated',
  'mcp_secret_bound', 'mcp_secret_rotated', 'mcp_secret_deleted', 'mcp_oauth_connected', 'mcp_oauth_revoked',
  'tenant_created', 'tenant_updated', 'tenant_disabled', 'tenant_enabled',
  'file_deleted',
  'session_soft_deleted', 'session_restored', 'session_permanently_deleted',
  'session_renamed', 'session_forked',
]);

/** 从 Express Request 构建并追加一条审计日志（fire-and-forget） */
export function auditLog(
  req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined>; user?: { sub: string; username: string; role: string } },
  event: LoginEvent,
  detail?: string,
): void {
  if (!_auditLogPath) return;
  // admin 用户跳过常规活动审计；但管理动作类事件强制记录（δ 阶段补丁）
  if (req.user?.role === 'admin' && !ADMIN_ALWAYS_AUDITED.has(event)) return;
  const entry: LoginLogEntry = {
    timestamp: new Date().toISOString(),
    event,
    username: req.user?.username || 'anonymous',
    userId: req.user?.sub,
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: (req.headers['user-agent'] as string) || 'unknown',
    channel: detectLoginChannel((req.headers['user-agent'] as string) || ''),
    ...(detail ? { detail } : {}),
  };
  appendLoginLog(entry, _auditLogPath).catch(() => {});
}
