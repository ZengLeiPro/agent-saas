/**
 * WP2a 安装实例路由（规范 §3.2、§3.6、§8.1、§8.4）。
 *
 * 平台管理员：建实例 / 域名验证 / 签凭据 / CAS 切换 registeredDigest / 启停删。
 * 组织管理员：只能 enable / disable **本组织**的实例，并查看运行状态。
 * 技术联系人本人：一次性领取凭据明文。
 * 服务凭据 Bearer：`credential-ack`（该路径已进 `PUBLIC_ROUTES`，在本 router 内自鉴权）。
 */
import type { PgEntitlementStore } from '../../data/entitlements/store.js';
import type { KyAppManagementQueries } from '../installations/managementQueries.js';
import { managementTenant, installableScope, installationActions } from '../installations/managementPolicy.js';
import { Router } from 'express';
import { z } from 'zod';

import { requirePlatformAdmin } from '../../auth/middleware.js';
import { isPlatformAdmin } from '../../auth/types.js';
import type { KyAppCredentialManager } from '../installations/credentials.js';
import type { KyAppInstallationService } from '../installations/service.js';
import type { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import { canManageTenant, governanceActorOf, sendKyAppError, sendKyAppFailure } from './support.js';

const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const createSchema = z.object({
  installationId: idSchema,
  tenantId: z.string().min(1).max(64),
  systemId: z.string().min(3).max(24),
  baseUrl: z.string().min(1).max(200),
  origin: z.string().min(1).max(200),
  techContactUserId: z.string().min(1).max(64),
});
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const registeredDigestSchema = z.object({
  digest: digestSchema,
  expectedRegisteredDigest: digestSchema.nullable().default(null),
});
const ticketSchema = z
  .string()
  .min(22)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface KyAppInstallationRoutesOptions {
  systems: PgKyAppSystemStore;
  management?: KyAppManagementQueries;
  entitlements?: PgEntitlementStore;
  installations: KyAppInstallationService;
  credentials: KyAppCredentialManager;
  runtimeStore: PgKyAppInstallationRuntimeStore;
}

export function createKyAppInstallationsRouter(options: KyAppInstallationRoutesOptions): Router {
  const router = Router();

  router.get('/installations', async (req, res) => {
    try {
      const tenantId = managementTenant(req.user, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
      const query = z.object({ systemId: z.string().optional(), status: z.enum(['pending','enabled','disabled','deleted']).optional(), cursor: z.string().max(1024).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(req.query);
      if (!query.success) return sendKyAppError(req, res, 'invalid_input', '分页或筛选参数非法');
      if (query.data.cursor) {
        try {
          const cursor = JSON.parse(Buffer.from(query.data.cursor, 'base64url').toString());
          if (typeof cursor.id !== 'string' || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))) throw new Error();
        } catch { return sendKyAppError(req, res, 'invalid_input', '分页游标非法'); }
      }
      if (!options.management) return sendKyAppError(req, res, 'unavailable', '管理查询不可用');
      res.json(await options.management.installations({ ...query.data, ...(tenantId ? { tenantId } : {}) }, req.user!));
    } catch (error) { sendKyAppFailure(req, res, error); }
  });

  router.post('/installations', async (req, res) => {
    if (!req.user || (!isPlatformAdmin(req.user) && req.user.role !== 'admin')) return sendKyAppError(req, res, 'forbidden', '需要管理员权限');
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) return sendKyAppError(req, res, 'invalid_input', '安装实例参数非法');
    try {
      managementTenant(req.user, body.data.tenantId);
      if (!isPlatformAdmin(req.user!)) {
        const allows = await installableScope(options.entitlements, body.data.tenantId);
        if (!allows(body.data.systemId)) return sendKyAppError(req, res, 'forbidden', '组织权益未授权此业务系统');
      }
      const installation = await options.installations.create(
        body.data,
        governanceActorOf(req.user!),
      );
      res.status(201).json({
        installation,
        // 归属验证的 TXT 记录直接给出，省去人工拼接出错。
        domainVerification: installation.domainVerificationToken
          ? {
              recordName: `_ky-app-verify.${new URL(installation.baseUrl).hostname}`,
              recordValue: installation.domainVerificationToken,
            }
          : null,
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/installations/:iid/verify-domain', requirePlatformAdmin, async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      const result = await options.installations.verifyDomain(
        iid.data,
        governanceActorOf(req.user!),
      );
      res.json(result);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/installations/:iid/credentials', requirePlatformAdmin, async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    try {
      await options.installations.require(iid.data);
      const ticket = await options.credentials.issue({ installationId: iid.data });
      // 明文一律不在这里返回；只给一次性领取票据与生命周期时间点。
      res.status(201).json({ credential: ticket });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/credentials', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const installation = await options.installations.require(iid.data);
      if (!canManageTenant(req.user, installation.tenantId)) {
        return sendKyAppError(req, res, 'forbidden', '需要平台管理员或本组织管理员权限');
      }
      res.json({ credentials: await options.credentials.listMetadata(iid.data) });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/credentials/claim/:ticket', async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const iid = idSchema.safeParse(req.params.iid);
    const ticket = ticketSchema.safeParse(req.params.ticket);
    if (!iid.success || !ticket.success) {
      return sendKyAppError(req, res, 'invalid_input', 'iid 或领取票据非法');
    }
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const installation = await options.installations.require(iid.data);
      if (installation.techContactUserId !== req.user.sub) {
        return sendKyAppError(req, res, 'forbidden', '只有已登记的技术联系人本人可以领取');
      }
      const claimed = await options.credentials.claim({
        installationId: iid.data,
        ticket: ticket.data,
      });
      res.setHeader('cache-control', 'no-store');
      res.json({ credential: claimed });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  /** 服务凭据 Bearer 自鉴权：该路径不经会话中间件（见 `auth/publicRoutes.ts`）。 */
  router.post('/installations/:iid/credential-ack', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token === '') return sendKyAppError(req, res, 'unauthorized', '缺少服务凭据');
    try {
      const record = await options.credentials.authenticate(token, 'credential-ack');
      if (!record || record.installationId !== iid.data) {
        return sendKyAppError(req, res, 'unauthorized', '服务凭据无效');
      }
      const acked = await options.credentials.acknowledge(token);
      res.json({
        credentialId: acked.credentialId,
        status: acked.status,
        ackedAt: acked.ackedAt,
        expiresAt: acked.expiresAt,
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  for (const action of ['enable', 'disable', 'delete'] as const) {
    router.post(`/installations/:iid/${action}`, async (req, res) => {
      const iid = idSchema.safeParse(req.params.iid);
      if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
      if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
      try {
        const installation = await options.installations.require(iid.data);
        const platformAdmin = isPlatformAdmin(req.user);
        if (!canManageTenant(req.user, installation.tenantId)) {
          return sendKyAppError(req, res, 'forbidden', '需要平台管理员或本组织管理员权限');
        }
        // `delete` 是不可逆的下线动作（§8.7），只允许平台管理员执行。
        if (action === 'delete' && !platformAdmin) {
          return sendKyAppError(req, res, 'forbidden', '删除安装实例需要平台管理员权限');
        }
        const updated = await options.installations.setStatus({
          installationId: iid.data,
          status: action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'deleted',
          actor: governanceActorOf(req.user),
          ...(platformAdmin ? {} : { limitToTenantId: req.user.tenantId }),
        });
        res.json({ installation: updated });
      } catch (error) {
        sendKyAppFailure(req, res, error);
      }
    });
  }

  router.post('/installations/:iid/registered-digest', requirePlatformAdmin, async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    const body = registeredDigestSchema.safeParse(req.body ?? {});
    if (!iid.success || !body.success) {
      return sendKyAppError(req, res, 'invalid_input', 'iid 或 digest 非法');
    }
    try {
      const runtime = await options.runtimeStore.get(iid.data);
      if (!runtime || runtime.readyStatus !== 'ok' || runtime.manifestDigest === null) {
        return sendKyAppError(req, res, 'conflict', '尚未取得该实例最近一次成功的 ready 上报');
      }
      const installation = await options.installations.setRegisteredDigest({
        installationId: iid.data,
        digest: body.data.digest,
        observedDigest: runtime.manifestDigest,
        expectedRegisteredDigest: body.data.expectedRegisteredDigest,
        actor: governanceActorOf(req.user!),
      });
      res.json({ installation });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/runtime', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const installation = await options.installations.require(iid.data);
      if (!canManageTenant(req.user, installation.tenantId)) {
        return sendKyAppError(req, res, 'forbidden', '需要平台管理员或本组织管理员权限');
      }
      const runtime = await options.runtimeStore.get(iid.data);
      const credentials = (await options.credentials.listRotationDue(iid.data)).map((record) => ({
        credentialId: record.credentialId,
        expiresAt: record.expiresAt,
      }));
      res.json({
        installation: {
          installationId: installation.installationId,
          systemId: installation.systemId,
          tenantId: installation.tenantId,
          status: installation.status,
          stateVersion: installation.stateVersion,
          registeredDigest: installation.registeredDigest,
          domainVerifiedAt: installation.domainVerifiedAt,
        },
        runtime,
        digestConsistent: runtime?.manifestDigest === installation.registeredDigest,
        credentialsExpiringSoon: credentials,
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/installations/:iid/management', async (req, res) => {
    const iid = idSchema.safeParse(req.params.iid);
    if (!iid.success) return sendKyAppError(req, res, 'invalid_input', 'iid 非法');
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const installation = await options.installations.require(iid.data);
      if (!canManageTenant(req.user, installation.tenantId)) {
        return sendKyAppError(req, res, 'forbidden', '需要平台管理员或本组织管理员权限');
      }
      const definition = await options.systems.getDefinition(installation.systemId);
      const version = installation.registeredDigest
        ? await options.systems.getVersion(installation.systemId, installation.registeredDigest)
        : null;
      const summary = await options.management?.installationSummary(iid.data);
      res.json({
        installation: {
          installationId: installation.installationId,
          tenantId: installation.tenantId,
          systemId: installation.systemId,
          baseUrl: installation.baseUrl,
          origin: installation.origin,
          techContactUserId: installation.techContactUserId,
          status: installation.status,
          registeredDigest: installation.registeredDigest,
          domainVerifiedAt: installation.domainVerifiedAt,
        },
        definition: definition
          ? {
              name: definition.name,
              status: definition.status,
              publishedDigest: definition.publishedDigest,
            }
          : null,
        ...summary,
        upgrade: { currentDigest: installation.registeredDigest, publishedDigest: definition?.publishedDigest ?? null, observedDigest: summary?.observedDigest ?? null, canSwitch: isPlatformAdmin(req.user) && installation.status !== 'deleted' && Boolean(summary?.ready && summary.observedDigest === definition?.publishedDigest && summary.observedDigest !== installation.registeredDigest) },
        manifest: version?.manifest ?? null,
        allowedActions: installationActions(req.user, installation),
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
