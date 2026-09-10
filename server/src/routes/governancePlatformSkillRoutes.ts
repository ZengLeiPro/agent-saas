import type { Request, Router } from 'express';
import { z } from 'zod';

import { hasPlatformCapability } from '../auth/platformGovernance.js';
import type { PlatformSkillConfig } from '../data/skills/types.js';
import { serverLogger } from '../utils/logger.js';

export type GovernanceResourcePersona = 'platform_admin' | 'org_admin' | 'member';

export type UpdatePlatformSkillSettings = (input: {
  skillId: string;
  settings: PlatformSkillConfig;
}) => Promise<boolean>;

const platformSkillSettingsSchema = z
  .object({
    enabled: z.boolean(),
    exposure: z.enum(['all', 'allow_tenants', 'deny_tenants']),
    tenantIds: z.array(z.string().min(1).max(128)).max(1_000),
  })
  .strict();

export function registerGovernancePlatformSkillRoutes(input: {
  router: Router;
  personaFor: (req: Request) => GovernanceResourcePersona | undefined;
  tenantExists?: (tenantId: string) => boolean;
  updatePlatformSkillSettings?: UpdatePlatformSkillSettings;
}): void {
  input.router.patch('/skills/:skillId/platform-settings', async (req, res) => {
    if (
      input.personaFor(req) !== 'platform_admin' ||
      !hasPlatformCapability(req.user, 'skill.platform.manage')
    ) {
      return res.status(403).json({
        error: '仅平台管理员可以修改平台技能设置',
        code: 'PLATFORM_CAPABILITY_REQUIRED',
        capability: 'skill.platform.manage',
      });
    }
    if (!input.updatePlatformSkillSettings) {
      return res.status(503).json({
        error: '平台技能设置服务暂不可用',
        code: 'SKILL_PLATFORM_SETTINGS_UNAVAILABLE',
      });
    }
    const parsed = platformSkillSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: '平台技能设置无效',
        code: 'SKILL_PLATFORM_SETTINGS_INVALID',
      });
    }
    const tenantIds = parsed.data.exposure === 'all' ? [] : [...new Set(parsed.data.tenantIds)];
    if (input.tenantExists && tenantIds.some((tenantId) => !input.tenantExists!(tenantId))) {
      return res.status(400).json({
        error: '开放范围中包含不存在的组织',
        code: 'SKILL_PLATFORM_TENANT_NOT_FOUND',
      });
    }
    const settings: PlatformSkillConfig = { ...parsed.data, tenantIds };
    try {
      const updated = await input.updatePlatformSkillSettings({
        skillId: req.params.skillId,
        settings,
      });
      if (!updated) {
        return res.status(404).json({ error: '平台技能不存在', code: 'PLATFORM_SKILL_NOT_FOUND' });
      }
      return res.json({ ok: true, changed: true, skillId: req.params.skillId, settings });
    } catch (error) {
      serverLogger.error(`PATCH platform skill settings failed: ${error}`);
      return res
        .status(500)
        .json({ error: '更新平台技能设置失败', code: 'SKILL_PLATFORM_SETTINGS_UPDATE_FAILED' });
    }
  });
}
