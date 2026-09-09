import { Router } from 'express';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import {
  DEFAULT_MINE_FAILURE_THRESHOLD,
  MySystemsService,
  parseExternalLinkHosts,
  resolveMineState,
} from '../systems/mySystemsService.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { MyBusinessSystem } from '../systems/mySystemsTypes.js';
import { sendKyAppError, sendKyAppFailure } from './support.js';

export { DEFAULT_MINE_FAILURE_THRESHOLD, parseExternalLinkHosts, resolveMineState };
export { KY_APP_MINE_STATES, type KyAppMineState } from '../systems/mySystemsTypes.js';
export type KyAppVisibleInstallation = MyBusinessSystem;

export interface KyAppMineRoutesOptions {
  systems?: PgKyAppSystemStore;
  assignments?: Pick<PgAssignmentStore, 'listEffectiveResourceIds'> & {
    listVisibleInstallationIds?: (
      tenantId: string,
      userId: string,
    ) => ReturnType<PgAssignmentStore['listEffectiveResourceIds']>;
  };
  runtimeStore?: Pick<PgKyAppInstallationRuntimeStore, 'get'>;
  failureThreshold?: number;
  service?: Pick<MySystemsService, 'listForUser'>;
}

export function createKyAppMineRouter(options: KyAppMineRoutesOptions): Router {
  const router = Router();
  const service =
    options.service ??
    (options.systems
      ? new MySystemsService({
          systems: options.systems,
          ...(options.assignments ? { assignments: options.assignments } : {}),
          ...(options.runtimeStore ? { runtimeStore: options.runtimeStore } : {}),
          failureThreshold: options.failureThreshold ?? DEFAULT_MINE_FAILURE_THRESHOLD,
        })
      : null);

  router.get('/systems/mine', async (req, res) => {
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    if (!service) return res.json({ installations: [] });
    try {
      res.json({
        installations: await service.listForUser(req.user.tenantId, req.user.sub),
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
