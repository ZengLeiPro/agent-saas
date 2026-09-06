import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { validateManifest, type Manifest } from '@kaiyan/ky-app-contract';

import { requirePlatformAdmin } from '../../auth/middleware.js';
import { isPlatformAdmin } from '../../auth/types.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import type { KyAppDiagnostics } from '../delivery/diagnostics.js';
import type { KyAppOnboardService } from '../delivery/onboard.js';
import type { KyAppDeliveryMetrics } from '../delivery/metrics.js';
import type { PgKyAppDeliveryStore } from '../delivery/store.js';
import type { KyAppCredentialManager } from '../installations/credentials.js';
import type { KyAppInstallationService } from '../installations/service.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import { canManageTenant, governanceActorOf, sendKyAppError, sendKyAppFailure } from './support.js';

const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
const phoneSchema = z.string().regex(/^1[3-9]\d{9}$/u);
const memberSchema = z.object({
  row: z.number().int().min(2),
  name: z.string().trim().min(1).max(100),
  phone: phoneSchema,
  departmentPath: z.string().trim().min(1).max(500),
  employeeNo: z.string().trim().min(1).max(100).optional(),
});
const onboardSchema = z.object({
  tenantId: z.string().trim().min(1).max(64),
  tenantName: z.string().trim().min(1).max(100),
  adminName: z.string().trim().min(1).max(100),
  adminPhone: phoneSchema,
  techContactPhone: phoneSchema,
  systemId: idSchema,
  installationId: idSchema,
  baseUrl: z.string().url().max(500),
  origin: z.string().url().max(500),
  grantCredits: z.number().int().min(0).max(10_000_000),
  manifest: z.record(z.string(), z.unknown()),
  members: z.array(memberSchema).max(5_000),
  diagnostic: z.object({
    readOnlyCapabilityId: idSchema,
    readOnlyInput: z.record(z.string(), z.unknown()),
  }),
  suggestedPrompts: z.array(z.string().trim().min(1).max(300)).max(3).optional(),
});
const offboardingSchema = z.object({
  status: z.enum(['planned', 'blocked']),
  plan: z.object({
    reason: z.string().trim().min(1).max(500),
    disableInstallation: z.boolean(),
    revokeCredentials: z.boolean(),
    exportOwner: z.string().trim().min(1).max(100).optional(),
    externalActions: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  }),
});
const executeOffboardingSchema = z.object({
  confirmInstallationId: idSchema,
  exportCompleted: z.literal(true),
  externalActionsCompleted: z.literal(true),
});

export function createKyAppDeliveryRouter(options: {
  store: PgKyAppDeliveryStore;
  systems: PgKyAppSystemStore;
  installations?: KyAppInstallationService;
  credentials?: KyAppCredentialManager;
  onboard?: KyAppOnboardService;
  metrics?: KyAppDeliveryMetrics;
  diagnostics?: KyAppDiagnostics;
  audit?: GovernanceAuditStore;
}): Router {
  const router = Router();

  router.post('/onboard', requirePlatformAdmin, async (req, res) => {
    if (!options.onboard)
      return sendKyAppError(req, res, 'unavailable', '交付编排依赖尚未完整装配');
    const parsed = onboardSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendKyAppError(req, res, 'invalid_input', '交付参数非法');
    const validation = validateManifest(parsed.data.manifest);
    if (!validation.ok)
      return sendKyAppError(
        req,
        res,
        'invalid_input',
        `manifest 校验失败：${validation.errors.join('；')}`,
      );
    if (parsed.data.manifest.systemId !== parsed.data.systemId)
      return sendKyAppError(req, res, 'invalid_input', 'manifest.systemId 与 systemId 不一致');
    try {
      const output = await options.onboard.run(
        {
          ...parsed.data,
          manifest: parsed.data.manifest as unknown as Manifest,
        },
        governanceActorOf(req.user!),
      );
      res.status(output.execution.status === 'completed' ? 200 : 202).json(output);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/onboard/:executionId', requirePlatformAdmin, async (req, res) => {
    try {
      const execution = await options.store.get(String(req.params.executionId));
      if (!execution) return sendKyAppError(req, res, 'not_found', '交付执行不存在');
      res.json({ execution });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/delivery', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const installation = await options.systems.getInstallation(iid.data);
      if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
      if (!canManageTenant(req.user, installation.tenantId))
        return sendKyAppError(req, res, 'forbidden', '无权查看该交付记录');
      res.json({ delivery: await options.store.getDelivery(iid.data) });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/usage', async (req, res) => {
    if (!options.metrics)
      return sendKyAppError(req, res, 'unavailable', '用量统计依赖尚未完整装配');
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const installation = await options.systems.getInstallation(iid.data);
      if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
      if (!canManageTenant(req.user, installation.tenantId))
        return sendKyAppError(req, res, 'forbidden', '无权查看该用量');
      res.json({ overview: await options.metrics.tenantOverview(installation.tenantId, iid.data) });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/usage', async (req, res) => {
    if (!options.metrics)
      return sendKyAppError(req, res, 'unavailable', '用量统计依赖尚未完整装配');
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    const tenantId =
      typeof req.query.tenantId === 'string' ? req.query.tenantId : req.user.tenantId;
    if (!canManageTenant(req.user, tenantId)) {
      return sendKyAppError(req, res, 'forbidden', '无权查看该组织用量');
    }
    try {
      res.json({ overview: await options.metrics.tenantOverview(tenantId) });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/guide', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const installation = await options.systems.getInstallation(iid.data);
      if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
      if (
        !req.user ||
        (!isPlatformAdmin(req.user) && req.user.tenantId !== installation.tenantId)
      ) {
        return sendKyAppError(req, res, 'forbidden', '无权查看该引导');
      }
      const delivery = await options.store.getDelivery(iid.data);
      res.json({ guide: delivery?.guide ?? null });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/installations/:iid/diagnose', async (req, res) => {
    if (!options.diagnostics)
      return sendKyAppError(req, res, 'unavailable', '诊断依赖尚未完整装配');
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const installation = await options.systems.getInstallation(iid.data);
      if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
      if (!req.user || !canManageTenant(req.user, installation.tenantId)) {
        return sendKyAppError(req, res, 'forbidden', '无权诊断该安装实例');
      }
      const execution = await options.store.getByIdentity(
        installation.tenantId,
        installation.systemId,
        installation.installationId,
      );
      const diagnostic = execution?.request.diagnostic as
        | {
            readOnlyCapabilityId?: unknown;
            readOnlyInput?: unknown;
          }
        | undefined;
      const adminUserId = isPlatformAdmin(req.user) ? execution?.result.adminUserId : req.user.sub;
      if (
        typeof adminUserId !== 'string' ||
        typeof diagnostic?.readOnlyCapabilityId !== 'string' ||
        typeof diagnostic.readOnlyInput !== 'object' ||
        diagnostic.readOnlyInput === null ||
        Array.isArray(diagnostic.readOnlyInput)
      ) {
        return sendKyAppError(req, res, 'conflict', '交付记录缺少管理员或只读能力诊断夹具');
      }
      const report = await options.diagnostics.run(iid.data, {
        adminUserId,
        readOnlyCapabilityId: diagnostic.readOnlyCapabilityId,
        readOnlyInput: diagnostic.readOnlyInput as Record<string, unknown>,
      });
      res.status(report.passed ? 200 : 409).json({ report });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/audit', async (req, res) => {
    if (!options.audit?.list)
      return sendKyAppError(req, res, 'unavailable', '治理审计读取尚未装配');
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const installation = await options.systems.getInstallation(iid.data);
      if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
      if (!req.user || !canManageTenant(req.user, installation.tenantId)) {
        return sendKyAppError(req, res, 'forbidden', '无权查看该安装实例操作记录');
      }
      const events = await options.audit.list({
        targetTenantId: installation.tenantId,
        limit: 200,
      });
      res.json({ events: events.filter((event) => event.targetId === iid.data).slice(0, 50) });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/signals', async (req, res) => {
    if (!options.metrics)
      return sendKyAppError(req, res, 'unavailable', '运行信号统计依赖尚未完整装配');
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const installation = await options.systems.getInstallation(iid.data);
      if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
      if (!req.user || !canManageTenant(req.user, installation.tenantId)) {
        return sendKyAppError(req, res, 'forbidden', '无权查看该安装实例运行信号');
      }
      res.json({
        signals: await options.metrics.installationSignals(installation.tenantId, iid.data),
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/deliveries', requirePlatformAdmin, async (req, res) => {
    try {
      res.json({ deliveries: await options.store.listDeliveries() });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/deliveries/health', requirePlatformAdmin, async (req, res) => {
    if (!options.metrics)
      return sendKyAppError(req, res, 'unavailable', '健康度统计依赖尚未完整装配');
    try {
      res.json({ items: await options.metrics.platformHealth() });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.put('/installations/:iid/offboarding', requirePlatformAdmin, async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    const body = offboardingSchema.safeParse(req.body ?? {});
    if (!iid.success || !body.success)
      return sendKyAppError(req, res, 'invalid_input', '离场计划参数非法');
    try {
      const delivery = await options.store.planOffboarding({
        installationId: iid.data,
        status: body.data.status,
        plan: body.data.plan,
      });
      res.json({ delivery });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post(
    '/installations/:iid/offboarding/execute-platform',
    requirePlatformAdmin,
    async (req, res) => {
      const iid = idSchema.safeParse(req.params.iid);
      const body = executeOffboardingSchema.safeParse(req.body ?? {});
      if (!iid.success || !body.success || body.data.confirmInstallationId !== iid.data) {
        return sendKyAppError(req, res, 'invalid_input', '离场确认参数非法或实例编号不匹配');
      }
      if (!options.installations || !options.credentials || !options.audit) {
        return sendKyAppError(req, res, 'unavailable', '离场执行依赖尚未完整装配');
      }
      try {
        const delivery = await options.store.getDelivery(iid.data);
        if (!delivery || !['planned', 'blocked'].includes(delivery.offboardingStatus)) {
          return sendKyAppError(
            req,
            res,
            'conflict',
            '必须先保存离场计划，且不能重复执行已完成计划',
          );
        }
        const plan = offboardingSchema.shape.plan.parse(delivery.offboardingPlan);
        const installation = await options.systems.getInstallation(iid.data);
        if (!installation) return sendKyAppError(req, res, 'not_found', '安装实例不存在');
        if (plan.disableInstallation && installation.status === 'deleted') {
          return sendKyAppError(req, res, 'conflict', '实例已经删除，不能继续执行离场计划');
        }
        const actor = governanceActorOf(req.user!);
        const correlationId = `ky-app-offboarding:${randomUUID()}`;
        await options.audit.append({
          correlationId,
          actorType: 'user',
          actorUserId: actor.sub,
          actorPersona: 'platform_admin',
          actorTenantId: req.user!.tenantId,
          action: 'ky_app.offboarding.execute',
          targetType: 'system_installation',
          targetId: iid.data,
          targetTenantId: installation.tenantId,
          purpose: 'confirmed_platform_offboarding',
          result: 'intent',
          metadata: {
            exportCompleted: true,
            externalActionsCompleted: true,
            disableInstallation: plan.disableInstallation,
            revokeCredentials: plan.revokeCredentials,
          },
        });
        await options.store.planOffboarding({
          installationId: iid.data,
          status: 'running',
          plan: delivery.offboardingPlan,
        });
        if (plan.disableInstallation && installation.status !== 'disabled') {
          await options.installations.setStatus({
            installationId: iid.data,
            status: 'disabled',
            actor,
          });
        }
        let revokedCredentials = 0;
        if (plan.revokeCredentials) {
          for (const credential of await options.credentials.listMetadata(iid.data)) {
            if (credential.status !== 'active' && credential.status !== 'pending_ack') continue;
            await options.credentials.revoke(credential.credentialId, iid.data);
            revokedCredentials += 1;
          }
        }
        const completedPlan = {
          ...delivery.offboardingPlan,
          platformExecution: {
            completedAt: new Date().toISOString(),
            completedBy: actor.sub,
            installationDisabled: plan.disableInstallation,
            revokedCredentials,
          },
        };
        const completed = await options.store.planOffboarding({
          installationId: iid.data,
          status: 'completed',
          plan: completedPlan,
        });
        await options.audit.append({
          correlationId,
          actorType: 'user',
          actorUserId: actor.sub,
          actorPersona: 'platform_admin',
          actorTenantId: req.user!.tenantId,
          action: 'ky_app.offboarding.execute',
          targetType: 'system_installation',
          targetId: iid.data,
          targetTenantId: installation.tenantId,
          purpose: 'confirmed_platform_offboarding',
          result: 'succeeded',
          metadata: { revokedCredentials, installationDisabled: plan.disableInstallation },
        });
        res.json({ delivery: completed, revokedCredentials });
      } catch (error) {
        const current = await options.store.getDelivery(iid.data).catch(() => null);
        await options.store
          .planOffboarding({
            installationId: iid.data,
            status: 'blocked',
            plan: {
              ...(current?.offboardingPlan ?? {}),
              failureCode: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
            },
          })
          .catch(() => undefined);
        sendKyAppFailure(req, res, error);
      }
    },
  );

  return router;
}
