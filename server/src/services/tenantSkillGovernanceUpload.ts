import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { SkillGovernanceInvariantError } from '../data/skillGovernance/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import { scanPoolSkillsAsync } from '../data/skills/scanner.js';
import { resolveTenantSkillsDir, resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import type { UserStore } from '../data/users/store.js';
import { agentSkillsDir, resolveAgentPath } from '../workspace/namespace.js';
import { resolveUserCwd } from '../workspace/resolver.js';
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
  skills: Pick<PgSkillGovernanceStore, 'getResource' | 'createAndPublishResource'>;
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

export function createTenantSkillGovernanceUpload(deps: TenantSkillGovernanceUploadDeps) {
  return async (input: {
    tenantId: string;
    actorUserId: string;
    files: Express.Multer.File[];
  }): Promise<TenantSkillGovernanceUploadResult> => {
    const staged = await stageSkillPackage(input.files);
    let installedDir: string | undefined;
    try {
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
        if (existsSync(join(userSkillsDir(deps, user), staged.skillId))) {
          throw new SkillPackageUploadError(
            'SKILL_SCOPE_CONFLICT',
            `技能“${staged.skillId}”与成员 ${user.username} 的自建技能同名，请改名后重试`,
            409,
          );
        }
      }
      if (await deps.skills.getResource(staged.skillId)) throw duplicateSkillError(staged.skillId);

      installedDir = await moveStagedSkillIntoPlace(staged, tenantSkillsDirFor(deps, input.tenantId), false);
      try {
        const governed = await deps.skills.createAndPublishResource({
          skillId: staged.skillId,
          tenantId: input.tenantId,
          scope: 'tenant',
          definition: {
            schemaVersion: 1,
            resourceType: 'skill',
            scope: 'tenant',
            tenantId: input.tenantId,
            source: 'governance_upload',
            packageFormat: 'skill-package-v1',
            name: staged.name,
            description: staged.description,
            contentDigest: staged.contentDigest,
            fileCount: staged.fileCount,
            totalBytes: staged.totalBytes,
          },
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
