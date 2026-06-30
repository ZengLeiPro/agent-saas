import { Router } from 'express';
import type { AppConfig } from '../types/index.js';
import type { DispatchMetricsSnapshot } from '../engine/metricsStore.js';

export interface HealthRouteOptions {
  getDispatchMetrics?: () => DispatchMetricsSnapshot;
  getActiveStreamCount?: () => number;
  getIsDraining?: () => boolean;
}

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

  // Config endpoint (for frontend to know current settings)
  router.get('/config', (_req, res) => {
    res.json({
      maxTurns: config.agent.maxTurns,
      permissionMode: config.agent.permissionMode,
    });
  });

  return router;
}
