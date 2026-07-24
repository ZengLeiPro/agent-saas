import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { requireSuperAdmin } from '../auth/platformGovernance.js';
import type { ToolControlsConfig } from '../app/config.js';
import { isToolEnabled } from '../agent/toolRuntime.js';
import { PLATFORM_TOOL_CATALOG } from '../agent/toolCatalog.js';
import { auditLog } from '../data/login-logs/index.js';
import {
  AGENT_PROFILE_BINDING_KEYS,
  AgentRuntimeProfileError,
  agentRuntimeProfileConfigSchema,
  type AgentProfileBindingKey,
  type AgentRuntimeProfileStore,
} from '../data/agentProfiles/types.js';

const createSchema = z.object({
  profileKey: z.string().trim().min(2).max(64),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2_000).optional(),
  purpose: z.string().max(2_000).optional(),
  config: agentRuntimeProfileConfigSchema.optional(),
}).strict();

const updateDraftSchema = z.object({
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2_000).optional(),
  purpose: z.string().max(2_000).optional(),
  config: agentRuntimeProfileConfigSchema.optional(),
}).strict();

const revisionSchema = z.object({
  expectedRevision: z.number().int().min(1),
}).strict();

const bindingSchema = z.object({ profileId: z.string().trim().min(1) }).strict();

export function createAgentRuntimeProfilesAdminRouter(options: {
  store: AgentRuntimeProfileStore;
  getToolControls?: () => ToolControlsConfig;
}): Router {
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get('/', async (_req, res) => {
    try {
      const [profiles, bindings] = await Promise.all([
        options.store.listProfiles(),
        options.store.listBindings(),
      ]);
      res.json({
        durable: options.store.durable,
        profiles,
        bindings,
        bindingKeys: AGENT_PROFILE_BINDING_KEYS,
        platformTools: {
          catalog: PLATFORM_TOOL_CATALOG.map((tool) => tool.id),
          enabled: PLATFORM_TOOL_CATALOG
            .filter((tool) => isToolEnabled(options.getToolControls?.(), tool))
            .map((tool) => tool.id),
        },
        semantics: {
          visibleToolsAreSecurityBoundary: false,
          shellWarning: '开启 Shell 时，模型可见工具范围不构成安全权限；真实边界由执行环境、sandbox、网络、凭据和后端鉴权共同决定。',
          publishedVersionsImmutable: true,
          newSessionsOnly: true,
          effectiveToolsDependOnRuntime: true,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/bindings', async (_req, res) => {
    try {
      res.json({ bindings: await options.store.listBindings() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/bindings/:bindingKey', requireSuperAdmin, async (req, res) => {
    const key = req.params.bindingKey;
    if (!isBindingKey(key)) {
      res.status(404).json({ error: '未知 Profile 运行场景' });
      return;
    }
    const parsed = bindingSchema.safeParse(req.body);
    if (!parsed.success) return sendValidation(res, parsed.error);
    try {
      const binding = await options.store.updateBinding(key, parsed.data.profileId, actor(req));
      auditLog(req, 'runtime_profile_binding_updated', JSON.stringify({
        bindingKey: key,
        profileId: parsed.data.profileId,
      }));
      res.json({ binding });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/', requireSuperAdmin, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendValidation(res, parsed.error);
    try {
      const profile = await options.store.createProfile({ ...parsed.data, actor: actor(req) });
      auditLog(req, 'runtime_profile_created', JSON.stringify({ profileId: profile.profileId, profileKey: profile.profileKey }));
      res.status(201).json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:profileId', async (req, res) => {
    try {
      const profile = await options.store.getProfile(req.params.profileId);
      if (!profile) return res.status(404).json({ error: 'Profile 不存在' });
      res.json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/:profileId/draft', requireSuperAdmin, async (req, res) => {
    const parsed = updateDraftSchema.safeParse(req.body);
    if (!parsed.success) return sendValidation(res, parsed.error);
    try {
      const profile = await options.store.updateDraft(req.params.profileId, { ...parsed.data, actor: actor(req) });
      auditLog(req, 'runtime_profile_draft_updated', JSON.stringify({
        profileId: profile.profileId,
        profileKey: profile.profileKey,
        revision: profile.revision,
        draftDigest: profile.draftDigest,
      }));
      res.json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:profileId/copy', requireSuperAdmin, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return sendValidation(res, parsed.error);
    try {
      const profile = await options.store.copyProfile(req.params.profileId, { ...parsed.data, actor: actor(req) });
      auditLog(req, 'runtime_profile_copied', JSON.stringify({
        sourceProfileId: req.params.profileId,
        profileId: profile.profileId,
        profileKey: profile.profileKey,
      }));
      res.status(201).json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:profileId/publish', requireSuperAdmin, async (req, res) => {
    const parsed = revisionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidation(res, parsed.error);
    try {
      const version = await options.store.publish(req.params.profileId, parsed.data.expectedRevision, actor(req));
      auditLog(req, 'runtime_profile_published', JSON.stringify({
        profileId: version.profileId,
        profileVersionId: version.profileVersionId,
        versionNumber: version.versionNumber,
        configDigest: version.configDigest,
      }));
      res.json({ version });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:profileId/archive', requireSuperAdmin, async (req, res) => {
    const parsed = revisionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidation(res, parsed.error);
    try {
      const profile = await options.store.archive(req.params.profileId, parsed.data.expectedRevision, actor(req));
      auditLog(req, 'runtime_profile_archived', JSON.stringify({ profileId: profile.profileId, profileKey: profile.profileKey }));
      res.json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:profileId/versions', async (req, res) => {
    try {
      res.json({ versions: await options.store.listVersions(req.params.profileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/:profileId/versions/:versionId', async (req, res) => {
    try {
      const version = await options.store.getVersion(req.params.versionId);
      if (!version || version.profileId !== req.params.profileId) {
        return res.status(404).json({ error: 'Profile 版本不存在' });
      }
      res.json({ version });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

function isBindingKey(value: string): value is AgentProfileBindingKey {
  return (AGENT_PROFILE_BINDING_KEYS as readonly string[]).includes(value);
}

function actor(req: Request): string {
  return req.user?.username || req.user?.sub || 'unknown';
}

function sendValidation(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') });
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof AgentRuntimeProfileError) {
    const status = error.code === 'NOT_FOUND' ? 404
      : error.code === 'NOT_DURABLE' ? 503
        : error.code === 'CONFLICT' || error.code === 'SYSTEM_PROFILE'
          || error.code === 'PROFILE_ARCHIVED' || error.code === 'PROFILE_NOT_PUBLISHED' ? 409
          : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}
