import { Router } from 'express';
import type { AppConfig } from '../types/index.js';
import type { DispatchMetricsSnapshot } from '../engine/metricsStore.js';
import type { ActiveRunCounts } from '../runtime/runStore.js';

export interface HealthRouteOptions {
  getDispatchMetrics?: () => DispatchMetricsSnapshot;
  getActiveStreamCount?: () => number;
  getActiveRunCounts?: () => Promise<ActiveRunCounts>;
  getIsDraining?: () => boolean;
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

/**
 * 创建健康检查和配置路由
 * @param config 应用配置
 * @returns Express Router
 */
export function createHealthRouter(
  config: AppConfig,
  options: HealthRouteOptions = {},
): Router {
  const router = Router();

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
      draining,
      ttsAvailable: !!config.tts,
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

  // ready：可以接流量才 200（draining → 503）。蓝绿部署门禁在新色端口上等
  // 它变 200 再切流。warmup 进度随载荷暴露但不 gate ready——skills 物化未
  // 完成时 dispatch 路径的版本化同步兜底正确性，部署脚本自行决定是否等
  // warmup.state=done 再切流。
  router.get('/healthz/ready', (_req, res) => {
    const draining = options.getIsDraining?.() ?? false;
    const warmup = options.getSkillsWarmupStatus?.() ?? { state: 'done' as const };
    res.status(draining ? 503 : 200).json({
      status: draining ? 'draining' : 'ok',
      draining,
      warmup,
    });
  });

  // 部署 drain 探针：给发布脚本判断是否可以切 release。
  // /healthz 仍保持纯文本，避免破坏 LB 和已有轻量探针。
  router.get('/healthz/drain', async (_req, res) => {
    const draining = options.getIsDraining?.() ?? false;
    const activeStreams = options.getActiveStreamCount?.() ?? 0;
    let activeRuns = ZERO_ACTIVE_RUN_COUNTS;
    try {
      activeRuns = await options.getActiveRunCounts?.() ?? ZERO_ACTIVE_RUN_COUNTS;
    } catch (err) {
      res.status(503).json({
        status: 'error',
        draining,
        activeStreams,
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
      activeRuns,
      idle: !draining && activeStreams === 0 && activeRuns.blocking === 0,
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
