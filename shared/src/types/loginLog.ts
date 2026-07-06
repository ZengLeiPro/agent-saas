export type LoginChannel = 'web' | 'mobile' | 'dingtalk';
export type LoginEvent =
  | 'login_success' | 'login_fail' | 'app_foreground' | 'app_background' | 'page_viewed'
  | 'chat_message_sent'
  | 'session_opened' | 'session_soft_deleted' | 'session_restored' | 'session_permanently_deleted' | 'session_renamed' | 'session_forked'
  | 'group_created' | 'group_updated' | 'group_deleted' | 'group_sessions_added' | 'group_sessions_removed' | 'group_sorting_updated'
  | 'cron_job_created' | 'cron_job_updated' | 'cron_job_deleted' | 'cron_job_toggled' | 'cron_job_triggered'
  | 'user_created' | 'user_updated' | 'user_deleted' | 'user_avatar_updated'
  | 'user_disabled' | 'user_enabled' | 'user_password_changed'
  | 'file_previewed' | 'file_downloaded' | 'file_deleted'
  | 'agent_profile_viewed' | 'agent_profile_updated'
  | 'agent_persona_viewed' | 'agent_persona_updated'
  | 'agent_memory_viewed' | 'agent_memory_updated'
  | 'agent_avatar_uploaded' | 'agent_avatar_reset'
  | 'skill_visibility_updated' | 'skill_promoted' | 'skill_custom_deleted' | 'skill_tenant_selections_updated' | 'skill_user_selections_updated'
  | 'skill_document_updated'
  | 'mcp_server_updated' | 'mcp_server_deleted' | 'mcp_user_selections_updated' | 'mcp_admin_user_selections_updated'
  | 'mcp_secret_bound' | 'mcp_secret_rotated' | 'mcp_secret_deleted' | 'mcp_oauth_connected' | 'mcp_oauth_revoked'
  | 'tenant_created' | 'tenant_updated' | 'tenant_disabled' | 'tenant_enabled' | 'tenant_deleted';

export interface LoginLogEntry {
  /** ISO 8601 */
  timestamp: string;
  event: LoginEvent;
  username: string;
  /** 登录失败（用户不存在）时缺失 */
  userId?: string;
  /** 多租户归属；旧日志可能缺失 */
  tenantId?: string;
  ip: string;
  userAgent: string;
  channel: LoginChannel;
  /** 仅 login_fail */
  failReason?: string;
  /** 客户端上报的 GPS 定位 */
  location?: { latitude: number; longitude: number };
  /** 操作审计详情（人类可读摘要） */
  detail?: string;
}

export interface LoginLogQuery {
  username?: string | string[];
  tenantId?: string;
  event?: LoginEvent;
  /** 按事件类别筛选（login/activity/session/group/cron/user/file/agent/skill/mcp/tenant） */
  category?: string;
  /** 按消息渠道筛选（web/mobile/dingtalk） */
  channel?: LoginChannel;
  startTime?: string;
  endTime?: string;
  offset?: number;
  limit?: number;
}

export interface LoginLogResponse {
  entries: LoginLogEntry[];
  total: number;
}
