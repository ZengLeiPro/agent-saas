/**
 * `tool_audit` 平台事件。
 *
 * 从 `runtime/types.ts` 的 `PlatformEvent` 判别联合里外提（该文件顶在 max-lines 棘轮上，
 * WP3 §6.2-8 要往这里加 11 个字段）。**判别联合的成员语义不变**，
 * `PlatformEvent` 里改成 `| ToolAuditPlatformEvent` 引用本类型。
 */
import type {
  ExecutionInvocationAudit,
  ToolAuthorization,
  ToolRisk,
  ExecutionTargetKind,
} from '../agent/toolRuntime.js';
import type { RunContext } from './types.js';

/**
 * WP3 §6.2-8：定制项目能力调用的审计扩展字段。
 *
 * 全部 optional —— 只有 `app__` 工具会带；其它工具的 `tool_audit` 行逐字节不变
 * （旧 jsonl 与 DuckDB 旧库都不受影响）。
 */
export type AppCapabilityAuditFields = {
  /** 操作人 KY userId（= SAT claim `sub`）。 */
  userId?: string;
  installationId?: string;
  capabilityId?: string;
  /** 逻辑调用 id。同一 lcid 的多次 attempt 只产生一行 tool_audit。 */
  lcid?: string;
  /** `X-KY-Request-Id`（= SAT claim `rid`）。 */
  requestId?: string;
  /** 登记 manifest digest（= SAT claim `dig`）。 */
  dig?: string;
  /** `sha256(JCS({cap, input}))`，与审批绑定的 `aph` 同值。**不存明文入参**。 */
  inputHash?: string;
  /** 响应体的 sha256。**不存明文结果**。 */
  outputHash?: string;
  /** 响应体 UTF-8 字节数（截断前）。 */
  outputBytes?: number;
  /** §6.5 错误码或 Gateway 内部处置码。 */
  errorCode?: string;
  /** 调用来源：Agent 工具调用 / 壳内 iframe 发起（§5.4）。 */
  origin?: string;
};

export type ToolAuditPlatformEvent = AppCapabilityAuditFields & {
  id: string;
  timestamp: string;
  type: 'tool_audit';
  runId: string;
  sessionId: string;
  /**
   * 组织 slug（PR 10 跨组织隔离）。
   * - 写入：rawAgentLoop emit 时从 args.context.channelContext.user.tenantId 注入；缺失兜底平台根组织
   * - 读取：旧 jsonl 行没有该字段 → 投影到 DuckDB 时归 legacy tenant；admin route 按 caller.tenantId 过滤
   * - 字段标 optional 仅为前向兼容旧 jsonl；新写入路径必带
   */
  tenantId?: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  /** Skill 工具实际加载的技能名；其它工具为空。 */
  skillName?: string;
  risk: ToolRisk;
  approvalId?: string;
  authorization: ToolAuthorization;
  executionTarget: ExecutionTargetKind;
  status: 'success' | 'error';
  durationMs: number;
  executionInvocations?: ExecutionInvocationAudit[];
  error?: string;
};

/** `AppCapabilityAuditFields` 的键顺序 = DuckDB 列顺序的唯一事实源。 */
export const APP_CAPABILITY_AUDIT_KEYS = [
  'userId',
  'installationId',
  'capabilityId',
  'lcid',
  'requestId',
  'dig',
  'inputHash',
  'outputHash',
  'outputBytes',
  'errorCode',
  'origin',
] as const satisfies readonly (keyof AppCapabilityAuditFields)[];

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 组装 `tool_audit` 的 `approvalId` 与 WP3 扩展字段。
 *
 * **为什么塞在一个 helper 里**：`rawAgentLoop.ts` 顶在 max-lines 棘轮上，
 * 只能以「一行换一行」的方式接入 —— 这个函数替换掉原先那行
 * `...(args.authorization.approvalId ? { approvalId: … } : {})`，净增 0 行。
 *
 * 数据来自 provider 在**截断前**产出的 `ToolResult.metadata`
 * （`kyapp/gateway/envelope.ts` 的 `buildAppResultMetadata`），
 * 不是从工具输出正文里反解 —— 正文可能已被截断，也可能被外部系统污染。
 */
export function buildToolAuditExtension(
  authorization: ToolAuthorization,
  context: Pick<RunContext, 'channelContext'>,
  metadata: Record<string, unknown> | undefined,
): AppCapabilityAuditFields & { approvalId?: string } {
  const approvalId = authorization.approvalId;
  const base = approvalId ? { approvalId } : {};
  if (!metadata || typeof metadata !== 'object') return base;
  // installationId 是「这是一次定制项目能力调用」的唯一判据；没有它就不写任何扩展字段。
  const installationId = readString(metadata, 'installationId');
  if (!installationId) return base;
  const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
  const outputBytes = metadata.outputBytes;
  return {
    ...base,
    installationId,
    ...(identity?.id ? { userId: identity.id } : {}),
    ...(readString(metadata, 'capabilityId')
      ? { capabilityId: readString(metadata, 'capabilityId') }
      : {}),
    ...(readString(metadata, 'lcid') ? { lcid: readString(metadata, 'lcid') } : {}),
    ...(readString(metadata, 'requestId') ? { requestId: readString(metadata, 'requestId') } : {}),
    ...(readString(metadata, 'dig') ? { dig: readString(metadata, 'dig') } : {}),
    ...(readString(metadata, 'inputHash') ? { inputHash: readString(metadata, 'inputHash') } : {}),
    ...(readString(metadata, 'outputHash')
      ? { outputHash: readString(metadata, 'outputHash') }
      : {}),
    ...(typeof outputBytes === 'number' && Number.isFinite(outputBytes) ? { outputBytes } : {}),
    ...(readString(metadata, 'errorCode') ? { errorCode: readString(metadata, 'errorCode') } : {}),
    origin: readString(metadata, 'origin') ?? 'agent_tool',
  };
}
