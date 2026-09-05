/** 附录 C：`GET /ky/v1/me` 的 TypeScript 形态。 */

export interface MenuBadge {
  count?: number;
}

export interface MenuItem {
  key: string;
  label: string;
  icon?: string;
  path: string;
  badge?: MenuBadge;
  children?: MenuItem[];
}

export interface MeUser {
  id: string;
  displayName: string;
  roles: string[];
  isTenantAdmin: boolean;
}

export interface MeCapability {
  id: string;
  enabled: boolean;
}

export interface MeResponse {
  contractVersion: 1;
  user: MeUser;
  /** 菜单为空时为 null，否则必须是某个叶子菜单的 path。 */
  landing: string | null;
  menus: MenuItem[];
  capabilities: MeCapability[];
  permVersion: string;
}

/** §4.6 `GET /ky/v1/health/live`。 */
export interface HealthLiveResponse {
  status: 'ok' | 'maintenance';
  etaMinutes?: number;
}

/** §4.6 `GET /ky/v1/health/ready`。 */
export interface HealthReadyResponse {
  status: 'ok' | 'maintenance';
  contractVersion: 1;
  appVersion: string;
  manifestDigest: string;
  installationState: InstallationState;
  deps: {
    db: boolean;
    executionStore: boolean;
    jtiStore: boolean;
    directorySync: { checkpoint: number; ageSeconds: number };
  };
  jwksKids: string[];
}

/** 安装实例状态（§3.7 事件驱动，`deleted` 为吸收终态）。 */
export type InstallationState = 'enabled' | 'disabled' | 'deleted';

/** §4.4 执行查询。 */
export type ExecutionStatus = 'not_started' | 'in_progress' | 'done' | 'failed' | 'expired';

export interface ExecutionQueryResponse {
  status: ExecutionStatus;
  result?: unknown;
  error?: { code: string; message?: string };
}

/** §4.3 能力调用成功响应。 */
export interface CapabilitySuccessResponse<TData = Record<string, unknown>> {
  ok: true;
  data: TData;
}
