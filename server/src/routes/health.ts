import { Router } from 'express';
import type { AppConfig } from '../types/index.js';
import type { DispatchMetricsSnapshot } from '../engine/metricsStore.js';
import type { RuntimeAdmissionSnapshot } from '../runtime/memoryPressureGuard.js';
import type { ActiveRunCounts } from '../runtime/runStore.js';
import type { UploadMetricsSnapshot } from '../uploads/manager.js';
import { assertRuntimeEnvironmentSafety } from '../release/environmentSafety.js';
import type { RuntimeIdentity } from '../release/runtimeIdentity.js';
import type { ConfigIdentitySummary } from '@agent/shared';
import type { EffectiveConfigStatus } from '../config/effectiveConfigStatus.js';
import { isTtsCapabilityEnabled } from '../integrations/tts/capability.js';

interface IntegrationV3HealthStatus {
  status: string;
  releaseReady: boolean;
  reasons: string[];
  metrics?: unknown;
}

export interface HealthRouteOptions {
  getDispatchMetrics?: () => DispatchMetricsSnapshot;
  getActiveStreamCount?: () => number;
  getUploadMetrics?: () => UploadMetricsSnapshot;
  getActiveRunCounts?: () => Promise<ActiveRunCounts>;
  getIsDraining?: () => boolean;
  getRuntimeAdmissionSnapshot?: () => RuntimeAdmissionSnapshot | undefined;
  /** Non-sensitive deployment identity. Staging must be safety-attested before ready. */
  getRuntimeIdentity?: () => RuntimeIdentity;
  /** TASK-318：只读脱敏配置身份摘要。 */
  getConfigIdentitySummary?: () => ConfigIdentitySummary | null;
  getEnvironmentSafetyAttested?: () => boolean;
  /** Non-sensitive effective configuration identity for deployment readback. */
  getEffectiveConfigStatus?: () => EffectiveConfigStatus;
  /** Integration v3 release gate. Errors fail readiness closed. */
  getIntegrationV3Health?: () => IntegrationV3HealthStatus | Promise<IntegrationV3HealthStatus>;
  /** skills 后台物化进度（结构类型，避免反向依赖 app/runtime）；ready 载荷用 */
  getSkillsWarmupStatus?: () => {
    state: 'pending' | 'running' | 'done' | 'failed';
    totalUsers?: number;
    processedUsers?: number;
    syncedUsers?: number;
    startedAtMs?: number;
    finishedAtMs?: number;
    error?: string;
  };
}

const ZERO_ACTIVE_RUN_COUNTS: ActiveRunCounts = {
  pending: 0,
  running: 0,
  waitingApproval: 0,
  waitingUser: 0,
  waitingHand: 0,
  blocking: 0,
  total: 0,
};

function buildPublicReleaseIdentity(release: RuntimeIdentity, safetyAttested: boolean) {
  return {
    environment: release.environment,
    releaseId: release.releaseId,
    releaseSha: release.releaseSha,
    serverDigest: release.serverDigest,
    webDigest: release.webDigest,
    acsOrchestratorDigest: release.acsOrchestratorDigest,
    acsSandboxImageDigest: release.acsSandboxImageDigest,
    safetyAttested,
  };
}

/**
 * 创建健康检查和配置路由
 * @param config 应用配置
 * @returns Express Router
 */
export function createHealthRouter(config: AppConfig, options: HealthRouteOptions = {}): Router {
  const router = Router();
  // Re-assert at route assembly so readiness only reports an identity proven by startup policy.
  const runtimeIdentity = assertRuntimeEnvironmentSafety(config);

  // Health check（未认证用户仅返回状态，认证用户返回详细信息）
  router.get('/health', (req, res) => {
    const draining = options.getIsDraining?.() ?? false;
    if (!req.user) {
      res.json({ status: draining ? 'draining' : 'ok' });
      return;
    }
    const mem = process.memoryUsage();
    res.json({
      status: draining ? 'draining' : 'ok',
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      activeStreams: options.getActiveStreamCount?.() ?? 0,
      uploads: options.getUploadMetrics?.(),
      draining,
      ttsAvailable: isTtsCapabilityEnabled(config.tts),
      dispatch: options.getDispatchMetrics?.(),
    });
  });

  // 轻量探针（部署脚本 / LB 使用）
  router.get('/healthz', (_req, res) => {
    if (options.getIsDraining?.()) {
      res.status(503).send('draining');
    } else {
      res.status(200).send('ok');
    }
  });

  // ── liveness / readiness 分离（2026-07-15 零停机部署批次）──────────
  // live：进程在即 200。systemd/监控判「要不要拉起/告警」用，不反映可服务状态。
  router.get('/healthz/live', (_req, res) => {
    res.status(200).send('ok');
  });

  // ready：可以接流量才 200（draining / runtime admission paused → 503）。
  // 蓝绿部署门禁在新色端口上等它变 200 再切流。warmup 进度随载荷暴露但不
  // gate ready——skills 物化未完成时，dispatch 路径的版本化同步兜底正确性，
  // 部署脚本自行决定是否等 warmup.state=done 再切流。
  router.get('/healthz/ready', async (_req, res) => {
    const draining = options.getIsDraining?.() ?? false;
    const runtimeAdmission = options.getRuntimeAdmissionSnapshot?.();
    const runtimeReady = runtimeAdmission?.admitting !== false;
    const warmup = options.getSkillsWarmupStatus?.() ?? { state: 'done' as const };
    const release = options.getRuntimeIdentity?.() ?? runtimeIdentity;
    const configIdentity = options.getConfigIdentitySummary?.() ?? undefined;
    // 新版 release 已绑定 expected 时，readiness 直接把一致性作为门禁；legacy 未绑定
    // expected 仍兼容。摘要本身只走平台管理员 API / 私有运行态快照，不进匿名响应。
    const configIdentityReady = !configIdentity?.expected || configIdentity.status === 'consistent';
    const safetyAttested =
      release?.safetyAttested !== false && (options.getEnvironmentSafetyAttested?.() ?? true);
    let integrationV3: IntegrationV3HealthStatus | undefined;
    try {
      integrationV3 = await options.getIntegrationV3Health?.();
    } catch (error) {
      res.status(503).json({
        status: 'not_ready',
        draining,
        warmup,
        ...(runtimeAdmission ? { runtimeAdmission } : {}),
        integrationV3: {
          status: 'degraded',
          releaseReady: false,
          reasons: ['metrics_unavailable'],
        },
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const releaseReady = integrationV3?.releaseReady !== false;
    const ready = !draining && runtimeReady && releaseReady && safetyAttested && configIdentityReady;
    const effectiveConfig = options.getEffectiveConfigStatus?.();
    res.status(ready ? 200 : 503).json({
      status: draining ? 'draining' : ready ? 'ok' : 'not_ready',
      draining,
      warmup,
      ...(runtimeAdmission ? { runtimeAdmission } : {}),
      ...(release ? { release: buildPublicReleaseIdentity(release, safetyAttested) } : {}),
      ...(effectiveConfig ? {
        configSchemaVersion: effectiveConfig.configSchemaVersion,
        effectiveConfigFingerprint: effectiveConfig.effectiveConfigFingerprint,
        capabilityFingerprint: effectiveConfig.capabilityFingerprint,
        secretReadiness: effectiveConfig.secretReadiness,
        environment: effectiveConfig.environment,
        appliedAt: effectiveConfig.appliedAt,
      } : {}),
      ...(integrationV3 ? { integrationV3 } : {}),
    });
  });

  // 部署 drain 探针：给发布脚本判断是否可以切 release。
  // /healthz 仍保持纯文本，避免破坏 LB 和已有轻量探针。
  router.get('/healthz/drain', async (_req, res) => {
    const draining = options.getIsDraining?.() ?? false;
    const activeStreams = options.getActiveStreamCount?.() ?? 0;
    const uploadMetrics = options.getUploadMetrics?.();
    const activeUploads = uploadMetrics?.activeUploads ?? 0;
    let activeRuns = ZERO_ACTIVE_RUN_COUNTS;
    try {
      activeRuns = (await options.getActiveRunCounts?.()) ?? ZERO_ACTIVE_RUN_COUNTS;
    } catch (err) {
      res.status(503).json({
        status: 'error',
        draining,
        activeStreams,
        activeUploads,
        activeRuns,
        idle: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    res.status(draining ? 503 : 200).json({
      status: draining ? 'draining' : 'ok',
      draining,
      activeStreams,
      activeUploads,
      activeRuns,
      idle: !draining && activeStreams === 0 && activeUploads === 0 && activeRuns.blocking === 0,
    });
  });

  // Config endpoint (for frontend to know current settings)
  router.get('/config', (_req, res) => {
    res.json({
      maxTurns: config.agent.maxTurns,
      permissionMode: config.agent.permissionMode,
    });
  });

  return router;
}
