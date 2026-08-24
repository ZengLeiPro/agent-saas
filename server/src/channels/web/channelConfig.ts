import type { ResolvedModel } from '../../app/models.js';
import type { GuardrailModelConfig } from '../../agent/guardrail.js';
import type { TitleGeneratorConfig, TitleModelAdapterFactory } from '../../agent/titleGenerator.js';
import type { BillingService } from '../../data/billing/service.js';
import type { GuardrailEventStore } from '../../data/guardrail/pgGuardrailEventStore.js';
import type { OrgAgentStore } from '../../data/orgAgents/store.js';
import type { SessionReadStateStore } from '../../data/sessionReadStateStore.js';
import type { TenantStore } from '../../data/tenants/store.js';
import type { TokenUsageStore } from '../../data/usage/store.js';
import type { SttConfig } from '../../integrations/stt/sttClient.js';
import type { RawApprovalResumeRequest } from '../../runtime/rawRuntimeRunDispatch.js';
import type { ExecutionConfig } from '../../runtime/executionConfig.js';
import type { RunPreflightService } from '../../runtime/runPreflight.js';
import type { RunStore } from '../../runtime/runStore.js';
import type { RuntimeScheduler } from '../../runtime/scheduler.js';
import type { SessionCatalog } from '../../runtime/sessionCatalog.js';
import type { ToolInvocationStore } from '../../runtime/toolInvocationStore.js';
import type { EventStore } from '../../runtime/types.js';
import type { UserOverrides } from '../../security/extraDirs.js';
import type { OutboundEvent } from '../../types/index.js';
import type { UploadManager } from '../../uploads/manager.js';

export type ModelResolver = (ref: string, tenantId?: string) => ResolvedModel | null;

export interface WebChannelRuntimeConfig {
  /** 是否启用 WebSocket 身份认证；直连测试缺省为 false。 */
  authEnabled?: boolean;
  /** 主 + fallback 链；主返回空或异常时按顺序回落，全部失败再 return null。 */
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  titleModelAdapterFactory?: TitleModelAdapterFactory;
  /** 标题生成前主动对齐共享 config.json，覆盖无主模型解析的手动命名路径。 */
  refreshSharedConfig?: () => void;
  /** 平台系统提示语热更新 getter；每次标题生成现取。 */
  getTitleSystemPrompt?: () => string;
  sttConfig?: SttConfig;
  userOverrides?: UserOverrides;
  /** Token 用量统计 store（可选，注入失败时静默跳过统计） */
  tokenUsageStore?: TokenUsageStore;
  /** PG Billing；getter 避免装配时序与 file backend 分支。 */
  billingService?: () => BillingService | undefined;
  /** Tenant store for disabled-tenant hard-stop checks. */
  tenantStore?: TenantStore;
  /** Browser WebSocket Origin allowlist，复用 HTTP CORS origins。 */
  allowedOrigins?: string[];
  /** Web 上传附件生命周期：消息通过校验后把 staged sidecar 原子标为 referenced。 */
  uploadManager?: UploadManager;
  /** 公司级专职 Agent store（orgAgentId 解析/audience 校验/门禁配置来源）。 */
  orgAgentStore?: OrgAgentStore;
  /**
   * 门禁模型配置链 getter（主 + fallback）。**必须是 getter**：模型列表热更新
   * 时 routes.ts 换新数组，channel 每次调用取最新链。空数组/缺省 = 门禁模块
   * 未激活（fail-open 短路）。
   */
  getGuardrailModelConfigs?: () => GuardrailModelConfig[];
  /** 门禁事件落库（PG backend）。缺省（file backend）时降级 log，判定照常。 */
  guardrailEventStore?: GuardrailEventStore;
  /** 用户维度会话未读状态真源。 */
  sessionReadStateStore?: SessionReadStateStore;
  /** 门禁调用参数（maxRecentRounds 现表示最近真实用户消息数，配置键为兼容历史保留）。 */
  guardrailOptions?: { timeoutMs?: number; maxRecentRounds?: number };
  /** 平台系统提示语热更新 getter；每次门禁调用现取。 */
  getGuardrailSystemPrompt?: () => string;
  /** raw runtime 持久化 approval 的恢复入口 */
  resumeApprovalDispatch?: (request: RawApprovalResumeRequest) => AsyncGenerator<OutboundEvent>;
  /** Runtime-level execution config；未传时使用 server-local 默认策略。 */
  executionConfig?: ExecutionConfig;
  /** Runtime EventStore 解析函数，用于 WS 重连恢复持久化 approval。 */
  runtimeEventStoreFor?: (transcriptPath: string, tenantId: string) => EventStore;
  /** 仅共享 PG EventStore 可在缺少 transcriptPath 时按 sessionId 读取。 */
  runtimeEventStoreSupportsPathless?: boolean;
  /** 新普通会话记忆写入职责 resolver；enqueue 首落库必须显式 pin。 */
  memoryWriteDelegationEnabled?: (tenantId: string | undefined) => boolean;
  /** Web chat enqueue-only runtime。 */
  enqueueRuntime?: {
    scheduler: RuntimeScheduler;
    runStore: RunStore;
    sessionCatalog: SessionCatalog;
    toolInvocationStore?: ToolInvocationStore;
    enabled?: boolean;
  };
  /** Governance Access/Run 统一 Preflight（shadow 阶段）。 */
  runPreflight?: RunPreflightService;
}
