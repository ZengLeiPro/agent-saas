/**
 * Dispatch Engine Types
 *
 * dispatch 中间件层的类型：指标、限流、审计、可观测性配置。
 * Agent 调度函数签名（AgentDispatch/AgentRunDispatch 等）已迁移到 agent/types.ts。
 */

import type { InboundMessage } from '../types/index.js';

export interface DispatchMetrics {
  runId: string;
  channel: InboundMessage['channel'];
  chatId: string;
  senderId?: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  firstEventLatencyMs: number | null;
  eventCount: number;
  errorCount: number;
}

export type DispatchMetricsReporter = (metrics: DispatchMetrics) => void;

export interface RateLimitOptions {
  enabled?: boolean;
  maxRequests?: number;
  windowMs?: number;
}

export interface AuditOptions {
  enabled?: boolean;
  path?: string;
  redact?: boolean;
  maxSizeBytes?: number;
  maxFiles?: number;
}

export interface LoggingOptions {
  level?: 'debug' | 'info' | 'warn' | 'error';
  timestamp?: boolean;
  timestampFormat?: 'full' | 'time' | 'none';
  colorEnabled?: boolean;
}

export interface ObservabilityOptions {
  enabled?: boolean;
  logging?: boolean | LoggingOptions;
  metrics?: boolean;
  audit?: AuditOptions;
}

export interface SandboxOptions {
  /** 追加到沙箱写白名单（家目录默认不可写） */
  allowWrite?: string[];
  /** 追加到沙箱读黑名单 */
  denyRead?: string[];
  /** 在 denyRead 覆盖范围内重新放行读权限 */
  allowRead?: string[];
}

export interface DispatchEngineOptions {
  enabled?: boolean;
  rateLimit?: RateLimitOptions;
  /** 非 admin 用户沙箱规则（admin 走 bypassPermissions 不受影响）；未配置字段走 DEFAULT_SANDBOX_* */
  sandbox?: SandboxOptions;
  /** 注入到 agent 子进程的环境变量（API Key 等） */
  env?: Record<string, string>;
}
