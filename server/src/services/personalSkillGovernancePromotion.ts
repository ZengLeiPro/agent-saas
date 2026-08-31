import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type { UserStore } from '../data/users/store.js';
import { agentSkillsDir } from '../workspace/namespace.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { SkillPackageUploadError } from './skillPackageUpload.js';
import {
  personalSkillResourceId,
  type TenantSkillGovernanceUploadResult,
} from './tenantSkillGovernanceUpload.js';

const MAX_SKILL_FILES = 300;
const MAX_SKILL_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_PACKAGE_BYTES = 100 * 1024 * 1024;

type PromoteTenantSkill = (input: {
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
}) => Promise<TenantSkillGovernanceUploadResult>;

export interface PersonalSkillGovernancePromotionDeps {
  skills: Pick<PgSkillGovernanceStore, 'getResource' | 'getVersion'>;
  userStore: Pick<UserStore, 'findByUsername'>;
  agentCwd: string;
  importTenantSkill: PromoteTenantSkill;
}

function invalidPromotion(code: string, message: string, status: number): SkillPackageUploadError {
  return new SkillPackageUploadError(code, message, status);
}

async function readSkillFiles(root: string): Promise<Express.Multer.File[]> {
  const files: Express.Multer.File[] = [];
  let totalBytes = 0;
  const visit = async (current: string, prefix = ''): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw invalidPromotion('SKILL_PACKAGE_UNSAFE', `技能包含不安全文件：${relativePath}`, 400);
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw invalidPromotion('SKILL_PACKAGE_UNSAFE', `技能包含不安全文件：${relativePath}`, 400);
      }
      totalBytes += info.size;
      if (
        files.length >= MAX_SKILL_FILES ||
        info.size > MAX_SKILL_FILE_BYTES ||
        totalBytes > MAX_SKILL_PACKAGE_BYTES
      ) {
        throw invalidPromotion('SKILL_PACKAGE_LIMIT_EXCEEDED', '技能包文件数量或大小超出限制', 413);
      }
      const buffer = await readFile(path);
      files.push({
        fieldname: 'files',
        originalname: relativePath,
        encoding: '7bit',
        mimetype: 'application/octet-stream',
        size: buffer.length,
        buffer,
        destination: '',
        filename: '',
        path: '',
        stream: undefined as never,
      });
    }
  };
  await visit(root);
  return files;
}

/** 组织管理员只触发服务端受控复制，不读取或返回成员的个人 Skill 内容。 */
export function createPersonalSkillGovernancePromotion(deps: PersonalSkillGovernancePromotionDeps) {
  return async (input: {
    tenantId: string;
    actorUserId: string;
    sourceUsername: string;
    skillId: string;
  }): Promise<TenantSkillGovernanceUploadResult> => {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.skillId)) {
      throw invalidPromotion('SKILL_PROMOTION_INVALID', '技能 ID 无效', 400);
    }
    const sourceUser = deps.userStore.findByUsername(input.sourceUsername);
    if (!sourceUser || sourceUser.tenantId !== input.tenantId) {
      throw invalidPromotion('SKILL_SOURCE_USER_NOT_FOUND', '来源用户不存在或不属于目标组织', 404);
    }
    const resourceId = personalSkillResourceId(sourceUser.id, input.skillId);
    const resource = await deps.skills.getResource(resourceId);
    if (
      !resource ||
      resource.tenantId !== input.tenantId ||
      resource.scope !== 'personal' ||
      resource.ownerUserId !== sourceUser.id ||
      resource.status !== 'published' ||
      !resource.currentVersionId
    ) {
      throw invalidPromotion(
        'PERSONAL_SKILL_GOVERNANCE_REQUIRED',
        '该个人技能尚未形成可发布的治理版本，请让技能所有者重新上传后再试',
        409,
      );
    }
    const version = await deps.skills.getVersion(resource.currentVersionId);
    const expectedContentDigest =
      version?.skillId === resourceId &&
      version.definition.legacySkillId === input.skillId &&
      typeof version.definition.contentDigest === 'string'
        ? version.definition.contentDigest
        : undefined;
    if (!expectedContentDigest) {
      throw invalidPromotion(
        'PERSONAL_SKILL_GOVERNANCE_REQUIRED',
        '该个人技能治理版本不完整，请让技能所有者重新上传后再试',
        409,
      );
    }

    const sourceDir = join(
      agentSkillsDir(
        resolveUserCwd(deps.agentCwd, {
          id: sourceUser.id,
          username: sourceUser.username,
          role: sourceUser.role as 'admin' | 'user',
          tenantId: sourceUser.tenantId,
        }),
      ),
      input.skillId,
    );
    if (!existsSync(sourceDir)) {
      throw invalidPromotion('SKILL_SOURCE_NOT_FOUND', `个人技能“${input.skillId}”不存在`, 404);
    }
    const sourceInfo = await lstat(sourceDir);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw invalidPromotion('SKILL_PACKAGE_UNSAFE', '个人技能目录不安全', 400);
    }

    return deps.importTenantSkill({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      files: await readSkillFiles(sourceDir),
      promotionSource: {
        ownerUserId: sourceUser.id,
        resourceId,
        versionId: resource.currentVersionId,
        expectedSkillId: input.skillId,
        expectedContentDigest,
      },
    });
  };
}
