/**
 * WP2a 系统目录与发布门禁路由（规范 §8.1，全部 `requirePlatformAdmin`）。
 *
 * `versions` 上传 → `validateManifest` → JCS digest → draft（同 digest 幂等）；
 * 语义 diff 命中即 `reviewRequired=true` 并落 `reviewReasons`；
 * `review` 由**非发布者**做；`publish` 门禁未过一律 409 `review_required`；
 * 模型端工具注册 dry-run 未配置时记 `skipped`（不算通过），原样写进响应的 `gate`。
 */
import { Router } from 'express';
import { z } from 'zod';

import { validateManifest, type Manifest } from '@kaiyan/ky-app-contract';

import { requirePlatformAdmin } from '../../auth/middleware.js';
import {
  governanceDigest,
  recordGovernanceIntent,
  recordGovernanceOutcome,
} from '../../data/governance-audit/recorder.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import {
  evaluateKyAppPublishGate,
  runKyAppToolRegistrationDryRun,
  type KyAppToolRegistrationDryRun,
} from '../systems/publishGate.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppSystemStatus } from '../systems/types.js';
import { governanceActorOf, sendKyAppError, sendKyAppFailure } from './support.js';

const systemIdSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const uploadSchema = z.object({
  name: z.string().min(1).max(40),
  manifest: z.record(z.string(), z.unknown()),
});
const statusSchema = z.object({
  status: z.enum(['disabled', 'retired']),
  expectedVersion: z.number().int().min(1),
});
const publishSchema = z.object({ expectedVersion: z.number().int().min(1) });

export interface KyAppSystemRoutesOptions {
  systems: PgKyAppSystemStore;
  audit?: GovernanceAuditStore;
  toolRegistrationDryRun?: KyAppToolRegistrationDryRun;
}

export function createKyAppSystemsRouter(options: KyAppSystemRoutesOptions): Router {
  const router = Router();

  router.get('/systems', requirePlatformAdmin, async (req, res) => {
    try {
      res.json({ systems: await options.systems.listDefinitions() });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/systems/:systemId/versions', requirePlatformAdmin, async (req, res) => {
    const systemId = systemIdSchema.safeParse(req.params.systemId);
    if (!systemId.success) return sendKyAppError(req, res, 'invalid_input', 'systemId 非法');
    try {
      res.json({ versions: await options.systems.listVersions(systemId.data) });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post('/systems/:systemId/versions', requirePlatformAdmin, async (req, res) => {
    const systemId = systemIdSchema.safeParse(req.params.systemId);
    if (!systemId.success) return sendKyAppError(req, res, 'invalid_input', 'systemId 非法');
    const body = uploadSchema.safeParse(req.body ?? {});
    if (!body.success) return sendKyAppError(req, res, 'invalid_input', 'name 与 manifest 必填');

    const validation = validateManifest(body.data.manifest);
    if (!validation.ok) {
      return sendKyAppError(
        req,
        res,
        'invalid_input',
        `manifest 校验失败：${validation.errors.join('；')}`,
      );
    }
    const manifest = body.data.manifest as unknown as Manifest;
    if (manifest.systemId !== systemId.data) {
      return sendKyAppError(req, res, 'invalid_input', 'manifest.systemId 与路径不一致');
    }

    try {
      const definition = await options.systems.getDefinition(systemId.data);
      const publishedManifest = await loadPublishedManifest(
        options.systems,
        systemId.data,
        definition?.publishedDigest ?? null,
      );
      const gate = evaluateKyAppPublishGate({ previous: publishedManifest, next: manifest });
      const actor = governanceActorOf(req.user!);
      const intent = await recordGovernanceIntent(options.audit, actor, {
        action: 'ky_app.system.version.register',
        targetType: 'system_definition',
        targetId: systemId.data,
        purpose: 'app_release_gate',
        metadata: { reviewRequired: gate.reviewRequired, reasonCount: gate.reasons.length },
      });
      const result = await options.systems.registerVersion({
        systemId: systemId.data,
        name: body.data.name,
        manifest: body.data.manifest,
        reviewStatus: gate.reviewRequired ? 'pending' : 'not_required',
        reviewReasons: gate.reasons,
        actor: actor.sub,
      });
      await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest({ digest: result.version.digest, created: result.created }),
        metadata: { manifestDigest: result.version.digest, created: result.created },
      });
      res.status(result.created ? 201 : 200).json({
        created: result.created,
        definition: result.definition,
        version: result.version,
        gate: { reviewRequired: gate.reviewRequired, reasons: gate.reasons },
        warnings: validation.warnings,
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.post(
    '/systems/:systemId/versions/:digest/review',
    requirePlatformAdmin,
    async (req, res) => {
      const systemId = systemIdSchema.safeParse(req.params.systemId);
      const digest = digestSchema.safeParse(req.params.digest);
      if (!systemId.success || !digest.success) {
        return sendKyAppError(req, res, 'invalid_input', 'systemId 或 digest 非法');
      }
      try {
        const actor = governanceActorOf(req.user!);
        const intent = await recordGovernanceIntent(options.audit, actor, {
          action: 'ky_app.system.version.review',
          targetType: 'system_definition_version',
          targetId: `${systemId.data}@${digest.data}`,
          purpose: 'app_release_gate',
          metadata: { manifestDigest: digest.data },
        });
        let version;
        try {
          version = await options.systems.reviewVersion({
            systemId: systemId.data,
            digest: digest.data,
            reviewer: actor.sub,
          });
        } catch (error) {
          await recordGovernanceOutcome(options.audit!, intent, 'failed', {
            metadata: { failureKind: 'review_rejected' },
          }).catch(() => undefined);
          throw error;
        }
        await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
          afterDigest: governanceDigest({ reviewStatus: version.reviewStatus }),
          metadata: {},
        });
        res.json({ version });
      } catch (error) {
        sendKyAppFailure(req, res, error);
      }
    },
  );

  router.post(
    '/systems/:systemId/versions/:digest/publish',
    requirePlatformAdmin,
    async (req, res) => {
      const systemId = systemIdSchema.safeParse(req.params.systemId);
      const digest = digestSchema.safeParse(req.params.digest);
      const body = publishSchema.safeParse(req.body ?? {});
      if (!systemId.success || !digest.success || !body.success) {
        return sendKyAppError(
          req,
          res,
          'invalid_input',
          'systemId / digest / expectedVersion 非法',
        );
      }
      try {
        const version = await options.systems.getVersion(systemId.data, digest.data);
        if (!version) return sendKyAppError(req, res, 'not_found', '未知系统版本');
        if (version.reviewStatus === 'pending') {
          return res.status(409).json({
            ok: false,
            error: {
              code: 'review_required',
              retryable: false,
              message: '该版本触发了语义 diff 门禁，必须由非发布者复核后才能发布',
              requestId: req.header('x-ky-request-id') ?? '',
            },
            reasons: version.reviewReasons,
          });
        }
        const dryRun = await runKyAppToolRegistrationDryRun(
          version.manifest as unknown as Manifest,
          options.toolRegistrationDryRun,
        );
        if (dryRun.status === 'failed') {
          return sendKyAppError(req, res, 'conflict', `工具注册 dry-run 失败：${dryRun.reason}`);
        }
        const actor = governanceActorOf(req.user!);
        const intent = await recordGovernanceIntent(options.audit, actor, {
          action: 'ky_app.system.version.publish',
          targetType: 'system_definition_version',
          targetId: `${systemId.data}@${digest.data}`,
          purpose: 'app_release_gate',
          metadata: { manifestDigest: digest.data, dryRunStatus: dryRun.status },
        });
        let published;
        try {
          published = await options.systems.publishVersion({
            systemId: systemId.data,
            digest: digest.data,
            expectedVersion: body.data.expectedVersion,
            actor: actor.sub,
          });
        } catch (error) {
          await recordGovernanceOutcome(options.audit!, intent, 'failed', {
            metadata: { failureKind: 'publish_rejected' },
          }).catch(() => undefined);
          throw error;
        }
        await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
          afterDigest: governanceDigest({ publishedDigest: published.definition.publishedDigest }),
          metadata: {},
        });
        res.json({ ...published, gate: { toolRegistrationDryRun: dryRun } });
      } catch (error) {
        sendKyAppFailure(req, res, error);
      }
    },
  );

  router.post('/systems/:systemId/status', requirePlatformAdmin, async (req, res) => {
    const systemId = systemIdSchema.safeParse(req.params.systemId);
    const body = statusSchema.safeParse(req.body ?? {});
    if (!systemId.success || !body.success) {
      return sendKyAppError(req, res, 'invalid_input', 'systemId 或 status 非法');
    }
    try {
      const actor = governanceActorOf(req.user!);
      const intent = await recordGovernanceIntent(options.audit, actor, {
        action: `ky_app.system.${body.data.status}`,
        targetType: 'system_definition',
        targetId: systemId.data,
        purpose: 'app_release_gate',
        metadata: { toState: body.data.status },
      });
      let definition;
      try {
        definition = await options.systems.updateDefinitionStatus({
          systemId: systemId.data,
          status: body.data.status as KyAppSystemStatus,
          expectedVersion: body.data.expectedVersion,
          actor: actor.sub,
        });
      } catch (error) {
        await recordGovernanceOutcome(options.audit!, intent, 'failed', {
          metadata: { failureKind: 'status_rejected' },
        }).catch(() => undefined);
        throw error;
      }
      await recordGovernanceOutcome(options.audit!, intent, 'succeeded', {
        afterDigest: governanceDigest({ status: definition.status }),
        metadata: {},
      });
      res.json({ definition });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}

async function loadPublishedManifest(
  systems: PgKyAppSystemStore,
  systemId: string,
  publishedDigest: string | null,
): Promise<Manifest | null> {
  if (!publishedDigest) return null;
  const version = await systems.getVersion(systemId, publishedDigest);
  return version ? (version.manifest as unknown as Manifest) : null;
}
