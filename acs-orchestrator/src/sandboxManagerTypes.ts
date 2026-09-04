/**
 * 单个 Sandbox 的规格覆盖（2026-08-10，A 方案批次 3）。
 * 未指定的字段回落到全局 env 默认值，因此可以只覆盖其中一项。
 * 该对象参与 provision 指纹，改规格会触发 pod 重建——正是期望行为。
 */
import type { SandboxLifecycleDecisionName, SandboxWorkloadClass, SandboxWorkloadDescriptor } from './sandboxLifecyclePolicy.js';

export interface SandboxResourceOverride {
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

export interface SandboxRef {
  name: string;
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
  mountSubPath: string;
  sharedReadOnlySubPath?: string;
  /** per-tenant/workspace 规格覆盖；缺省时用全局默认。 */
  resources?: SandboxResourceOverride;
  workload?: SandboxWorkloadDescriptor;
  /** ensure 发现目标资源但因 busy/protection 暂未收敛；调用方不得写入成功快缓存。 */
  resourceDriftDeferred?: true;
}

/** Result of one lifecycle cleanup pass. */
export interface SandboxCleanupReport {
  checked: number;
  paused: string[];
  deleted: string[];
  /**
   * 2026-08-01：矛盾态自愈回收的 sandbox。phase=Paused 但 broken（SandboxPaused
   * condition 卡 False/ImageChanged、或 spec.paused=false 半状态）超过宽限期，
   * ACS 对这种「假暂停」持续按运行态计费；巡检删除 CR 止损，NAS workspace 保留，
   * 下次访问自动重建。07-22 事故 21 个、08-01 复发 6 个的兜底修复。
   */
  brokenRecycled: string[];
  skippedBusy: string[];
  snatDeleted: string[];
  snatUnexpected: number;
  runningCount: number;
  totalCount: number;
  policyMode?: 'shadow' | 'enforce';
  decisionCounts?: Record<string, number>;
}

export interface SandboxStaleImagePrewarmReport {
  checked: number;
  queued: string[];
  /**
   * 2026-08-01 语义变更：旧 prewarm（原地 applySandbox 换镜像 + 保持 Running 等
   * idle pause）在 ACS 侧不可靠——07-22/08-01 两轮事故实证：apply 失败无回滚会留
   * 半状态；apply「成功」后续 pause 仍卡 SandboxPaused=False/ImageChanged，均持续
   * 计费。stale Paused sandbox 改为直接删除 CR（retired），NAS workspace 不动，
   * 用户下次访问按新镜像走 create 冷启动。对照实证：recreate 路径 pause 正常。
   */
  retired: string[];
  adopted: string[];
  skipped: string[];
  skippedBusy: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface SandboxInventorySummary {
  totalCount: number;
  phaseCounts: Record<string, number>;
  runningCount: number;
  pausedCount: number;
  allocatedCount: number;
  pendingReservationCount: number;
  evictablePausedCount: number;
  executionReady: boolean;
  allocatedCpuMillicores: number;
  allocatedMemoryBytes: number;
  availableCount: number | null;
  availableCpuMillicores: number | null;
  availableMemoryBytes: number | null;
  oldestCreatedAt?: string;
  newestLastActiveAt?: string;
  workloadClassCounts: Record<SandboxWorkloadClass, number>;
  lifecycleDecisionCounts: Partial<Record<SandboxLifecycleDecisionName, number>>;
  lifecyclePolicyMode: 'shadow' | 'enforce';
}
