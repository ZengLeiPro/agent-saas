/**
 * 与 server/src/routes/runtimeTrace.ts + server/src/runtime/efficiencyQuery.ts
 * 的输出类型保持一致。不跨包 import（web 不依赖 server），手工镜像。
 */

/** run 状态白名单（与后端 RUN_STATUS_WHITELIST 对齐） */
export type RunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "waiting_hand"
  | "completed"
  | "failed"
  | "cancelled";

export const RUN_STATUSES: RunStatus[] = [
  "pending",
  "running",
  "waiting_approval",
  "waiting_user",
  "waiting_hand",
  "completed",
  "failed",
  "cancelled",
];

// ────────── GET /recent-runs ──────────

export interface RecentRunSummary {
  runId: string;
  sessionId: string;
  tenantId: string | null;
  userId: string | null;
  status: string;
  statusReason: string | null;
  model: string | null;
  channel: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  /** 终态耗时（终态时间戳 - started_at），能算则算 */
  durationMs?: number;
}

export interface RecentRunsResponse {
  runs: RecentRunSummary[];
}

// ────────── GET /runs/:runId/events ──────────

export interface RunSummary {
  status: string;
  statusReason: string | null;
  model: string | null;
  channel: string | null;
  tenantId: string | null;
  userId: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  executionTarget: string | null;
  workspaceId: string | null;
  cumulativeInputTokens: number;
}

export interface BillingRequestRow {
  requestIndex: number;
  actualModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costYuan: number;
  createdAt: string;
}

export interface RunBillingSummary {
  totalCostYuan: number;
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  models: string[];
  requests: BillingRequestRow[];
}

export interface TraceToolCall {
  id: string;
  name: string;
  /** JSON 字符串（可能被后端截断） */
  arguments: string;
}

/**
 * 事件信封 + 各类型自有字段的宽松合并视图。
 * 后端按类型返回不同字段，前端按 type 分支取用；未知字段透传保留。
 */
export interface TraceEvent {
  id: string;
  type: string;
  timestamp: string;
  sessionId?: string;
  runId?: string | null;
  /** 任一大文本字段被后端截断时为 true */
  truncated?: boolean;
  // user_message / memory_context / assistant_thinking / assistant_message /
  // assistant_tool_calls / tool_result / tool_output_delta
  content?: string;
  model?: string;
  // assistant_tool_calls
  toolCalls?: TraceToolCall[];
  // tool_result / tool_audit / approval_requested
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // tool_audit
  status?: string;
  risk?: string;
  durationMs?: number;
  executionTarget?: string;
  error?: string;
  // approval_requested / approval_resolved
  approvalId?: string;
  input?: unknown;
  decision?: string;
  message?: string;
  // run_state_changed
  previousStatus?: string;
  reason?: string;
  // run_finished
  subtype?: string;
  numTurns?: number;
  // hand_provisioned / hand_failure
  handId?: string;
  workspaceId?: string;
  classifiedAs?: string;
  // run_lease_acquired
  workerId?: string;
  leaseExpiresAt?: string;
  // run_enqueued
  userId?: string;
  [key: string]: unknown;
}

export interface RunEventsResponse {
  runId: string;
  sessionId: string;
  run: RunSummary;
  billing: RunBillingSummary;
  events: TraceEvent[];
}

// ────────── GET /efficiency ──────────

export interface EfficiencyReport {
  range: { from: string; to: string; days: number };
  tenantId: string | null;
  outcome: {
    totalRuns: number;
    success: number;
    error: number;
    interrupted: number;
    /** success / total；total=0 时 null */
    completionRate: number | null;
    errorReasons: Array<{ reason: string; count: number; sampleRunId: string | null }>;
  };
  tools: {
    byTool: Array<{
      toolName: string;
      calls: number;
      errors: number;
      errorRate: number | null;
      totalDurationMs: number;
      avgDurationMs: number | null;
    }>;
    handFailures: number;
  };
  cost: {
    totalCostYuan: number;
    byModel: Array<{
      model: string;
      costYuan: number;
      requests: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      cacheHitRate: number | null;
    }>;
    perRun: { p50: number | null; p90: number | null; p99: number | null };
    failedRunsCostYuan: number;
    cacheHitRate: number | null;
  };
  longTail: {
    slowestRuns: Array<{
      runId: string;
      sessionId: string;
      tenantId: string | null;
      durationMs: number;
      status: string;
      model: string | null;
    }>;
    mostTurns: Array<{ runId: string; sessionId: string; tenantId: string | null; turns: number }>;
  };
  approvals: {
    count: number;
    resolvedCount: number;
    waitP50Ms: number | null;
    waitP90Ms: number | null;
    byTool: Array<{ toolName: string; count: number; avgWaitMs: number | null }>;
  };
  waste: {
    duplicateToolCalls: {
      affectedRuns: number;
      totalDuplicateCalls: number;
      topOffenders: Array<{ toolName: string; duplicates: number }>;
    };
    repeatedFileReads: {
      affectedRuns: number;
      topFiles: Array<{ filePath: string; repeats: number; runId: string }>;
    };
    unmodifiedRetries: {
      count: number;
      byTool: Array<{ toolName: string; count: number }>;
    };
  };
}
