import { Router } from 'express';

import type { ApnsService } from '../apns/service.js';
import type { WebPushService } from '../webPush/service.js';
import { createApnsRouter } from './apns.js';
import { createWebPushRouter } from './webPush.js';

export interface PushNotificationRouterOptions {
  webPush?: WebPushService;
  apns?: ApnsService;
}

/**
 * 推送通知两条通道的设备管理路由，挂在 `/api` 下：
 * - `/web-push/*`：浏览器 Web Push 订阅（Web 端）
 * - `/apns/*`：iOS 系统推送设备（原生 App）
 */
export function createPushNotificationRouter(options: PushNotificationRouterOptions): Router {
  const router = Router();
  router.use('/web-push', createWebPushRouter(options.webPush));
  router.use('/apns', createApnsRouter(options.apns));
  return router;
}
