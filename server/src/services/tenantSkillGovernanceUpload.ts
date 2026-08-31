import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { SkillGovernanceInvariantError } from '../data/skillGovernance/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import { scanPoolSkillsAsync, scanTenantOwnSkillIdsAsync } from '../data/skills/scanner.js';
import { resolveTenantSkillsDir, resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import type { UserStore } from '../data/users/store.js';
import { setUserSkillSelected } from '../routes/skillSelection.js';
import { agentSkillsDir, resolveAgentPath } from '../workspace/namespace.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { MATERIALIZED_CONTENT_DIGEST_ALGORITHM } from '../workspace/materialization/fingerprint.js';
import {
  moveStagedSkillIntoPlace,
  SkillPackageUploadError,
  stageSkillPackage,
} from './skillPackageUpload.js';

export interface TenantSkillGovernanceUploadResult {
  ok: true;
  status: 'succeeded';
  skill: { id: string; name: string; description: string };
  resource: Awaited<ReturnType<PgSkillGovernanceStore['createAndPublishResource']>>['resource'];
  version: Awaited<ReturnType<PgSkillGovernanceStore['createAndPublishResource']>>['version'];
}

export interface TenantSkillGovernanceUploadDeps {
  skills: Pick<PgSkillGovernanceStore, 'getResource' | 'createAndPublishResource' | 'restoreAndPublishResource'>;
  skillConfigStore: Pick<SkillConfigStore, 'getPoolVisibility'>;
  userStore: Pick<UserStore, 'listAll'>;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
}

function tenantSkillsDirFor(deps: TenantSkillGovernanceUploadDeps, tenantId: string): string {
  return deps.tenantSkillsRootDir
    ? resolveTenantSkillsDirFromRoot(deps.tenantSkillsRootDir, tenantId)
    : resolveTenantSkillsDir(deps.sharedDir, tenantId);
}

function userSkillsDir(deps: Pick<TenantSkillGovernanceUploadDeps, 'agentCwd'>, user: ReturnType<UserStore['listAll']>[number]): string {
  const cwd = resolveUserCwd(deps.agentCwd, {
    id: user.id,
    username: user.username,
    role: user.role as 'admin' | 'user',
    tenantId: user.tenantId,
  });
  return agentSkillsDir(cwd);
}

function duplicateSkillError(skillId: string): SkillPackageUploadError {
  return new SkillPackageUploadError(
    'SKILL_VERSION_CONFLICT',
    `技能“${skillId}”已存在，请修改 name 或版本后重试`,
    409,
  );
}

export function tenantSkillResourceId(tenantId: string, legacySkillId: string): string {
  return `tenant_${createHash('sha256')
    .update(`${tenantId}\0${legacySkillId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function createTenantSkillGovernanceUpload(deps: TenantSkillGovernanceUploadDeps) {
  return async (input: {
    tenantId: string;
    actorUserId: string;
    files: Express.Multer.File[];
    promotionSource?: {
      ownerUserId: string;
      resourceId: string;
      versionId: string;
      expectedSkillId: string;
      expectedContentDigest: string;
    };
  }): Promise<TenantSkillGovernanceUploadResult> => {
    const staged = await stageSkillPackage(input.files);
    let installedDir: string | undefined;
    try {
      if (input.promotionSource
        && (staged.skillId !== input.promotionSource.expectedSkillId
          || staged.contentDigest !== input.promotionSource.expectedContentDigest)) {
        throw new SkillPackageUploadError(
          'SKILL_SOURCE_VERSION_DRIFT',
          '个人技能内容已发生变化，请让技能所有者重新上传形成新治理版本后再试',
          409,
        );
      }
      const poolDir = resolveAgentPath(deps.sharedDir, 'skills-pool');
      const platformSkillIds = new Set([
        ...(await scanPoolSkillsAsync(poolDir)).map(skill => skill.id),
        ...Object.keys(deps.skillConfigStore.getPoolVisibility()),
      ]);
      if (platformSkillIds.has(staged.skillId)) {
        throw new SkillPackageUploadError(
          'SKILL_SCOPE_CONFLICT',
          `技能“${staged.skillId}”与平台技能同名，请改名后重试`,
          409,
        );
      }
      for (const user of deps.userStore.listAll()) {
        if (user.tenantId !== input.tenantId) continue;
        if (user.id === input.promotionSource?.ownerUserId) continue;
        if (existsSync(join(userSkillsDir(deps, user), staged.skillId))) {
          throw new SkillPackageUploadError(
            'SKILL_SCOPE_CONFLICT',
            `技能“${staged.skillId}”与成员 ${user.username} 的自建技能同名，请改名后重试`,
            409,
          );
        }
      }
      const resourceId = tenantSkillResourceId(input.tenantId, staged.skillId);
      const existing = await deps.skills.getResource(resourceId);
      const skillsParent = tenantSkillsDirFor(deps, input.tenantId);
      if (existsSync(join(skillsParent, staged.skillId))) throw duplicateSkillError(staged.skillId);
      if (existing && (existing.tenantId !== input.tenantId
        || existing.scope !== 'tenant'
        || !['published', 'retired'].includes(existing.status))) {
        throw duplicateSkillError(staged.skillId);
      }
      const definition = {
        schemaVersion: 1,
        resourceType: 'skill',
        scope: 'tenant',
        tenantId: input.tenantId,
        legacySkillId: staged.skillId,
        source: input.promotionSource ? 'personal_skill_promotion' : 'governance_upload',
        ...(input.promotionSource ? {
          sourceResourceId: input.promotionSource.resourceId,
          sourceVersionId: input.promotionSource.versionId,
        } : {}),
        packageFormat: 'skill-package-v1',
        contentDigestAlgorithm: MATERIALIZED_CONTENT_DIGEST_ALGORITHM,
        name: staged.name,
        description: staged.description,
        contentDigest: staged.contentDigest,
        fileCount: staged.fileCount,
        totalBytes: staged.totalBytes,
      };

      installedDir = await moveStagedSkillIntoPlace(staged, skillsParent, false);
      try {
        const governed = existing
          ? await deps.skills.restoreAndPublishResource({
              skillId: resourceId,
              tenantId: input.tenantId,
              scope: 'tenant',
              expectedRevision: existing.revision,
              definition,
              publishedBy: input.actorUserId,
            })
          : await deps.skills.createAndPublishResource({
              skillId: resourceId,
              tenantId: input.tenantId,
              scope: 'tenant',
              definition,
              createdBy: input.actorUserId,
            });
        return {
          ok: true,
          status: 'succeeded',
          skill: { id: staged.skillId, name: staged.name, description: staged.description },
          resource: governed.resource,
          version: governed.version,
        };
      } catch (error) {
        await rm(installedDir, { recursive: true, force: true });
        installedDir = undefined;
        if (error instanceof SkillGovernanceInvariantError
          && error.code === 'SKILL_RESOURCE_VERSION_CONFLICT') {
          throw duplicateSkillError(staged.skillId);
        }
        throw error;
      }
    } finally {
      await staged.dispose();
    }
  };
}

export function personalSkillResourceId(userId: string, legacySkillId: string): string {
  return `personal_${createHash('sha256')
    .update(`${userId}\0${legacySkillId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export interface PersonalSkillGovernanceUploadResult {
  ok: true;
  status: 'succeeded';
  selected: true;
  skill: { id: string; name: string; description: string };
  resource: Awaited<ReturnType<PgSkillGovernanceStore['createAndPublishResource']>>['resource'];
  version: Awaited<ReturnType<PgSkillGovernanceStore['createAndPublishResource']>>['version'];
}

export interface PersonalSkillGovernanceUploadDeps {
  skills: Pick<PgSkillGovernanceStore, 'getResource' | 'createAndPublishResource' | 'restoreAndPublishResource'>;
  skillConfigStore: SkillConfigStore;
  userStore: Pick<UserStore, 'findById'>;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
}

export function createPersonalSkillGovernanceUpload(deps: PersonalSkillGovernanceUploadDeps) {
  return async (input: {
    tenantId: string;
    actorUserId: string;
    files: Express.Multer.File[];
  }): Promise<PersonalSkillGovernanceUploadResult> => {
    const actor = deps.userStore.findById(input.actorUserId);
    if (!actor || actor.tenantId !== input.tenantId) {
      throw new SkillPackageUploadError('SKILL_OWNER_SCOPE_DENIED', '当前用户与组织作用域不匹配', 403);
    }
    const staged = await stageSkillPackage(input.files);
    try {
      const poolDir = resolveAgentPath(deps.sharedDir, 'skills-pool');
      const platformSkillIds = new Set([
        ...(await scanPoolSkillsAsync(poolDir)).map(skill => skill.id),
        ...Object.keys(deps.skillConfigStore.getPoolVisibility()),
      ]);
      const tenantSkillsDir = deps.tenantSkillsRootDir
        ? resolveTenantSkillsDirFromRoot(deps.tenantSkillsRootDir, input.tenantId)
        : resolveTenantSkillsDir(deps.sharedDir, input.tenantId);
      const tenantSkillIds = await scanTenantOwnSkillIdsAsync(tenantSkillsDir, platformSkillIds)
        .catch(() => new Set<string>());
      if (platformSkillIds.has(staged.skillId) || tenantSkillIds.has(staged.skillId)) {
        throw new SkillPackageUploadError(
          'SKILL_SCOPE_CONFLICT',
          `技能“${staged.skillId}”与平台或组织技能同名，请改名后重试`,
          409,
        );
      }
      const resourceId = personalSkillResourceId(actor.id, staged.skillId);
      const existing = await deps.skills.getResource(resourceId);
      const userSkillsParent = userSkillsDir(deps, actor);
      if (existsSync(join(userSkillsParent, staged.skillId))) throw duplicateSkillError(staged.skillId);
      if (existing && (existing.tenantId !== input.tenantId
        || existing.scope !== 'personal'
        || existing.ownerUserId !== actor.id
        || !['published', 'retired'].includes(existing.status))) {
        throw duplicateSkillError(staged.skillId);
      }
      const definition = {
        schemaVersion: 1,
        resourceType: 'skill',
        scope: 'personal',
        tenantId: input.tenantId,
        ownerUserId: actor.id,
        legacySkillId: staged.skillId,
        source: 'governance_upload',
        packageFormat: 'skill-package-v1',
        contentDigestAlgorithm: MATERIALIZED_CONTENT_DIGEST_ALGORITHM,
        name: staged.name,
        description: staged.description,
        contentDigest: staged.contentDigest,
        fileCount: staged.fileCount,
        totalBytes: staged.totalBytes,
      };
      const wasSelected = deps.skillConfigStore.getUserSelectedSkills(actor.username).includes(staged.skillId);
      const installedDir = await moveStagedSkillIntoPlace(staged, userSkillsParent, true);
      let selectionEnabled = false;
      try {
        // 先写默认选择，再发布治理资源。这样选择存储故障不会留下已发布但不可重试的资源。
        await setUserSkillSelected(deps.skillConfigStore, actor.username, staged.skillId, true);
        selectionEnabled = true;
        const governed = existing
          ? await deps.skills.restoreAndPublishResource({
              skillId: resourceId,
              tenantId: input.tenantId,
              scope: 'personal',
              ownerUserId: actor.id,
              expectedRevision: existing.revision,
              definition,
              publishedBy: actor.id,
            })
          : await deps.skills.createAndPublishResource({
              skillId: resourceId,
              tenantId: input.tenantId,
              scope: 'personal',
              ownerUserId: actor.id,
              definition,
              createdBy: actor.id,
            });
        return {
          ok: true,
          status: 'succeeded',
          selected: true,
          skill: { id: staged.skillId, name: staged.name, description: staged.description },
          resource: governed.resource,
          version: governed.version,
        };
      } catch (error) {
        // 发布失败时回滚先写入的选择；失败本身不能把用户锁在脏偏好上。
        if (selectionEnabled) {
          try {
            await setUserSkillSelected(deps.skillConfigStore, actor.username, staged.skillId, wasSelected);
          } catch {
            // 原始错误更重要；若选择存储本身不可用，下一次重试会重新校正状态。
          }
        }
        await rm(installedDir, { recursive: true, force: true });
        if (error instanceof SkillGovernanceInvariantError
          && error.code === 'SKILL_RESOURCE_VERSION_CONFLICT') {
          throw duplicateSkillError(staged.skillId);
        }
        throw error;
      }
    } finally {
      await staged.dispose();
    }
  };
}
