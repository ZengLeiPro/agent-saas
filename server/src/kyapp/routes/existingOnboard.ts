import { Router } from 'express';
import { z } from 'zod';
import type { Manifest } from '@kaiyan/ky-app-contract';
import { requirePlatformAdmin } from '../../auth/middleware.js';
import {
  recordGovernanceIntent,
  recordGovernanceOutcome,
} from '../../data/governance-audit/recorder.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { KyAppManagementQueries } from '../installations/managementQueries.js';
import {
  connectionSettingsSchema,
  validateConnectionSettings,
} from '../delivery/connectionSettings.js';
import {
  KyAppExistingOnboardService,
  type ExistingOnboardOptions,
} from '../delivery/existingOnboard.js';
import { governanceActorOf, sendKyAppError, sendKyAppFailure } from './support.js';

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
const inputSchema = z
  .object({
    tenantId: id,
    systemId: id,
    techContactUserId: id,
    expectedSettingsVersion: z.number().int().nonnegative(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    deployment: z
      .object({ baseUrl: z.string().url().max(500), origin: z.string().url().max(500) })
      .strict()
      .optional(),
  })
  .strict();

export function createKyAppExistingOnboardRouter(
  options: ExistingOnboardOptions & {
    management: KyAppManagementQueries;
    audit?: GovernanceAuditStore;
  },
) {
  const router = Router();
  const service = new KyAppExistingOnboardService(options);
  router.param('systemId', (req, res, next, value) => {
    if (!id.safeParse(value).success)
      return sendKyAppError(req, res, 'invalid_input', '系统标识格式不正确');
    next();
  });
  router.param('tenantId', (req, res, next, value) => {
    if (!id.safeParse(value).success)
      return sendKyAppError(req, res, 'invalid_input', '组织标识格式不正确');
    next();
  });
  // 这些路由只服务平台侧组织接入；每次继续都重新校验组织权益和成员状态。
  router.get('/systems/:systemId/connection-options', requirePlatformAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const systemId = id.parse(req.params.systemId);
      const definition = await options.systems.getDefinition(systemId);
      if (!definition) return sendKyAppError(req, res, 'not_found', '未知业务系统');
      const [connections, settings] = await Promise.all([
        options.management.connectionsForSystem(systemId),
        options.settings.get(systemId),
      ]);
      res.json({
        ...settings,
        publishedDigest: definition.publishedDigest,
        published: definition.status === 'published',
        organizations: options.tenants
          .listAllStrict()
          .filter((tenant) => !tenant.disabled)
          .map((tenant) => ({
            id: tenant.id,
            name: tenant.name,
            connection: connections.find((item) => item.tenantId === tenant.id) ?? null,
          })),
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });
  router.get(
    '/systems/:systemId/connection-options/:tenantId',
    requirePlatformAdmin,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        res.json(
          await service.organizationOptions(
            id.parse(req.params.systemId),
            id.parse(req.params.tenantId),
          ),
        );
      } catch (error) {
        sendKyAppFailure(req, res, error);
      }
    },
  );
  router.get('/systems/:systemId/connection-settings', requirePlatformAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const systemId = id.parse(req.params.systemId);
      if (!(await options.systems.getDefinition(systemId)))
        return sendKyAppError(req, res, 'not_found', '未知业务系统');
      res.json(await options.settings.get(systemId));
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });
  router.post('/systems/:systemId/connection-settings', requirePlatformAdmin, async (req, res) => {
    const parsed = z
      .object({
        settings: connectionSettingsSchema,
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) return sendKyAppError(req, res, 'invalid_input', '接入配置格式不正确');
    try {
      const systemId = id.parse(req.params.systemId);
      const definition = await options.systems.getDefinition(systemId);
      if (!definition || definition.status === 'retired')
        return sendKyAppError(req, res, 'conflict', '系统不存在或已退役');
      validateConnectionSettings(parsed.data.settings, options.config);
      if (parsed.data.settings.diagnostic) {
        const version = definition.publishedDigest
          ? await options.systems.getVersion(systemId, definition.publishedDigest)
          : null;
        const manifest = version?.manifest as unknown as Manifest | undefined;
        if (
          !manifest?.capabilities.some(
            (capability) =>
              capability.id === parsed.data.settings.diagnostic!.readOnlyCapabilityId &&
              capability.riskLevel === 'read_only',
          )
        )
          return sendKyAppError(req, res, 'invalid_input', '诊断只能选择已发布版本的只读能力');
      }
      const actor = governanceActorOf(req.user!);
      const intent = await recordGovernanceIntent(options.audit, actor, {
        action: 'ky_app.system.connection_settings',
        targetType: 'system_definition',
        targetId: systemId,
        purpose: 'app_installation_provisioning',
        metadata: {},
      });
      try {
        const result = await options.settings.save(
          systemId,
          parsed.data.settings,
          parsed.data.expectedVersion,
          actor.sub,
        );
        await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
          metadata: { version: result.version },
        });
        res.json(result);
      } catch (error) {
        await recordGovernanceOutcome(options.audit!, intent, 'failed', { metadata: {} }).catch(
          () => undefined,
        );
        throw error;
      }
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });
  router.post('/onboard-existing', requirePlatformAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success)
      return sendKyAppError(req, res, 'invalid_input', '请选择组织和技术联系人，并确认系统配置');
    try {
      const result = await service.start(parsed.data, governanceActorOf(req.user!));
      res.status(result.execution.status === 'completed' ? 200 : 202).json(result);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });
  router.post('/onboard-existing/:executionId/resume', requirePlatformAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await service.resume(
        String(req.params.executionId),
        governanceActorOf(req.user!),
      );
      res.status(result.execution.status === 'completed' ? 200 : 202).json(result);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });
  return router;
}
