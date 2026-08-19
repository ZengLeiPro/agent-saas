import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SkillConfigStore } from '../../data/skills/store.js';
import { resolveTenantSkillsDir, resolveTenantSkillsDirFromRoot } from '../../data/tenants/tenantSkillsPath.js';
import { serverLogger } from '../../utils/logger.js';
import {
  agentDir,
  agentPath,
  agentScriptsDir,
  agentSkillsDir,
  resolveAgentPath,
} from '../namespace.js';
import { repairWorkspaceTreeAsync } from '../permissions.js';
import type { WorkspaceUser } from '../resolver.js';
import {
  computeDesiredHash,
  computeDirectoryFingerprint,
  shouldIncludeMaterializedPath,
} from './fingerprint.js';
import {
  readSkillManifest,
  SKILL_MATERIALIZATION_MANIFEST_VERSION,
  type MaterializedSkillEntry,
  writeSkillManifest,
} from './manifest.js';
import { detectLegacyTenantSkillIds } from './legacyProvenance.js';
import type { SkillMaterializationResult } from './types.js';

interface DesiredSkill extends MaterializedSkillEntry {
  id: string;
  sourceDir: string;
}

export interface SkillMaterializerOptions {
  sharedDir: string;
  sourceRevision: string;
  tenantSkillsRootDir?: string;
  skillConfigStore: SkillConfigStore;
  resolveAssignedOrgAgentSkillIds?: (user: WorkspaceUser) => readonly string[];
  resolveTenantSkillHistoricalProvenance?: (
    tenantId: string,
  ) => Promise<ReadonlyMap<string, readonly string[]>>;
}

export interface MaterializeWorkspaceInput {
  taskId: string;
  user: WorkspaceUser;
  userCwd: string;
  requiredSkillIds?: readonly string[];
  forceSourceRefresh?: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function listDirectoryIds(root: string): Promise<Set<string>> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => (
          entry.isDirectory()
          && !entry.name.startsWith('.')
          && !entry.name.startsWith('_')
        ))
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

async function copyManagedDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (path) => {
      if (path !== source && !shouldIncludeMaterializedPath(path)) return false;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`技能源不允许包含软链接：${path}`);
      }
      return true;
    },
  });
}

export class SkillWorkspaceMaterializer {
  private readonly logger = serverLogger.child('SkillMaterializer');
  private sourceDigestCacheVersion = -1;
  private readonly sourceDigestCache = new Map<string, string>();
  private readonly validatedConfigVersions = new Map<string, number>();

  constructor(private readonly options: SkillMaterializerOptions) {}

  async isReady(
    userCwd: string,
    requiredSkillIds: readonly string[] = [],
  ): Promise<boolean> {
    const manifest = await readSkillManifest(userCwd);
    if (!manifest) return false;
    const configVersion = this.options.skillConfigStore.getConfigVersion();
    // 蓝绿并存时旧 release 绝不能用旧源覆盖新 release 已完成的 workspace。
    if (manifest.configVersion > configVersion) return true;
    if (manifest.configVersion !== configVersion) return false;
    // sourceRevision 只用于隔离蓝绿 release 的队列消费者，不参与 workspace
    // 内容正确性判断。技能内容变化会由启动指纹 bump configVersion；若内容未变，
    // 新 release 应直接复用现有 manifest，避免每次发布都重建全用户任务。
    return requiredSkillIds.every((id) => !!manifest.skills[id]);
  }

  /**
   * configVersion 只作为快速缓存代次，不再作为物化正确性本身。版本不同时按当前
   * 用户的真实目标集合和逐技能摘要复核；其他用户的局部配置变化不会制造全员任务。
   */
  async isReadyForUser(
    user: WorkspaceUser,
    userCwd: string,
    requiredSkillIds: readonly string[] = [],
  ): Promise<boolean> {
    const manifest = await readSkillManifest(userCwd);
    if (!manifest) return false;
    const configVersion = this.options.skillConfigStore.getConfigVersion();
    if (manifest.configVersion > configVersion) return true;
    if (!requiredSkillIds.every((id) => !!manifest.skills[id])) return false;
    if (manifest.configVersion === configVersion) return true;

    const cacheKey = [
      userCwd,
      ...[...new Set(requiredSkillIds)].sort(),
    ].join('\0');
    if (this.validatedConfigVersions.get(cacheKey) === configVersion) return true;

    const desired = await this.resolveDesiredSkills(user, requiredSkillIds);
    const desiredHash = computeDesiredHash(
      desired.map((skill) => [skill.id, skill.digest]),
    );
    const scriptsDigest = await this.resolveScriptsDigest();
    const ready = manifest.desiredHash === desiredHash
      && manifest.scriptsDigest === scriptsDigest;
    if (ready) this.validatedConfigVersions.set(cacheKey, configVersion);
    return ready;
  }

  async isSuperseded(userCwd: string): Promise<boolean> {
    const manifest = await readSkillManifest(userCwd);
    return !!manifest
      && manifest.configVersion > this.options.skillConfigStore.getConfigVersion();
  }

  async materialize(input: MaterializeWorkspaceInput): Promise<SkillMaterializationResult> {
    const { user, userCwd } = input;
    if (input.forceSourceRefresh) {
      this.sourceDigestCacheVersion = -1;
      this.sourceDigestCache.clear();
    }
    const skillsDir = agentSkillsDir(userCwd);
    const runtimeDir = agentPath(userCwd, 'runtime');
    const stagingRoot = join(runtimeDir, 'skill-materialization-staging');
    const backupRoot = join(runtimeDir, 'skill-materialization-backups', input.taskId);
    await mkdir(agentDir(userCwd), { recursive: true });
    const skillsPathInfo = await lstat(skillsDir).catch(() => null);
    if (skillsPathInfo?.isSymbolicLink()) {
      await this.moveToBackup(
        skillsDir,
        join(backupRoot, `legacy-skills-symlink-${randomUUID()}`),
      );
    } else if (skillsPathInfo && !skillsPathInfo.isDirectory()) {
      throw new Error(`技能目录不是文件夹：${skillsDir}`);
    }
    await mkdir(skillsDir, { recursive: true });

    const desired = await this.resolveDesiredSkills(user, input.requiredSkillIds ?? []);
    const desiredHash = computeDesiredHash(desired.map((skill) => [skill.id, skill.digest]));
    const previous = await readSkillManifest(userCwd);
    const configVersion = this.options.skillConfigStore.getConfigVersion();
    let trustedLegacyVersion = false;
    if (!previous) {
      try {
        trustedLegacyVersion = Number.parseInt(
          (await readFile(agentPath(userCwd, '.skills-version'), 'utf-8')).trim(),
          10,
        ) === configVersion;
      } catch {
        trustedLegacyVersion = false;
      }
    }
    const previousSkills = previous?.skills ?? {};
    const legacyTenantSkillIds = previous
      ? new Set<string>()
      : await detectLegacyTenantSkillIds({
          userCwd,
          userSkillsDir: skillsDir,
          tenantsRootDir: this.options.tenantSkillsRootDir ?? join(this.options.sharedDir, 'tenants'),
          currentTenantId: user.tenantId,
          poolSkillIds: await listDirectoryIds(resolveAgentPath(this.options.sharedDir, 'skills-pool')),
          resolveTenantSkillHistoricalProvenance: this.options.resolveTenantSkillHistoricalProvenance,
        });
    const nextSkills: Record<string, MaterializedSkillEntry> = {};
    let changedSkills = 0;
    let skippedSkills = 0;
    let removedSkills = 0;

    for (const skill of desired) {
      const destination = join(skillsDir, skill.id);
      const destinationExists = await pathExists(destination);
      const destinationIsRealDirectory = await isRealDirectory(destination);
      let unchanged = destinationIsRealDirectory && previousSkills[skill.id]?.digest === skill.digest;
      if (destinationExists && !previousSkills[skill.id] && trustedLegacyVersion) {
        unchanged = destinationIsRealDirectory
          && await pathExists(join(destination, 'SKILL.md'));
      } else if (destinationIsRealDirectory && !previousSkills[skill.id]) {
        // 首次从旧 `.skills-version` 迁入逐技能 manifest：只异步读一次现有副本，
        // 内容相同就直接纳管，不制造一轮 370MB 的无意义覆盖。
        try {
          unchanged = await computeDirectoryFingerprint(destination) === skill.digest;
        } catch {
          unchanged = false;
        }
      }

      if (unchanged) {
        skippedSkills++;
      } else {
        await this.stageAndCommitDirectory({
          source: skill.sourceDir,
          destination,
          stagingRoot,
          backupRoot,
          name: skill.id,
          expectedDigest: skill.digest,
          validateSkillDocument: true,
        });
        changedSkills++;
      }
      nextSkills[skill.id] = {
        digest: skill.digest,
        source: skill.source,
        ...(skill.tenantId ? { tenantId: skill.tenantId } : {}),
      };
    }

    const knownManagedIds = await this.resolveKnownManagedSkillIds(user, previousSkills);
    for (const id of legacyTenantSkillIds) knownManagedIds.add(id);
    const desiredIds = new Set(desired.map((skill) => skill.id));
    for (const id of knownManagedIds) {
      if (desiredIds.has(id)) continue;
      const destination = join(skillsDir, id);
      if (!await pathExists(destination)) continue;
      await this.moveToBackup(destination, join(backupRoot, `removed-${id}-${randomUUID()}`));
      removedSkills++;
    }

    const scriptsDigest = await this.materializeScripts({
      userCwd,
      stagingRoot,
      backupRoot,
      previousDigest: previous?.scriptsDigest,
    });

    await writeSkillManifest(userCwd, {
      version: SKILL_MATERIALIZATION_MANIFEST_VERSION,
      desiredHash,
      configVersion,
      sourceRevision: this.options.sourceRevision,
      generatedAt: new Date().toISOString(),
      skills: nextSkills,
      ...(scriptsDigest ? { scriptsDigest } : {}),
    });
    this.validatedConfigVersions.clear();

    this.logger.info(
      `Materialized skills for ${user.username}: changed=${changedSkills} skipped=${skippedSkills} removed=${removedSkills}`,
    );
    return { changedSkills, skippedSkills, removedSkills, desiredHash };
  }

  private async resolveDesiredSkills(
    user: WorkspaceUser,
    requiredSkillIds: readonly string[],
  ): Promise<DesiredSkill[]> {
    const poolDir = resolveAgentPath(this.options.sharedDir, 'skills-pool');
    const poolIds = await listDirectoryIds(poolDir);
    if (poolIds.size === 0) {
      throw new Error(`技能池为空或不存在：${poolDir}`);
    }

    let tenantDir: string | null = null;
    let tenantIds = new Set<string>();
    if (user.tenantId) {
      tenantDir = this.options.tenantSkillsRootDir
        ? resolveTenantSkillsDirFromRoot(this.options.tenantSkillsRootDir, user.tenantId)
        : resolveTenantSkillsDir(this.options.sharedDir, user.tenantId);
      tenantIds = await listDirectoryIds(tenantDir);
      for (const poolId of poolIds) tenantIds.delete(poolId);
    }

    const assignedOrgSkills = this.options.resolveAssignedOrgAgentSkillIds?.(user) ?? [];
    const orgSkillIds = [...new Set([...assignedOrgSkills, ...requiredSkillIds])];
    const targetIds = new Set<string>([
      ...this.options.skillConfigStore.getUserEffectivePoolSkills(user.username, user.tenantId),
      ...this.options.skillConfigStore.getUserEffectiveTenantOwnSkills(user.username, user.tenantId, tenantIds),
      ...this.options.skillConfigStore.getOrgAgentEffectivePoolSkills(user.tenantId, orgSkillIds),
      ...this.options.skillConfigStore.getOrgAgentEffectiveTenantOwnSkills(user.tenantId, tenantIds, orgSkillIds),
    ]);

    const desired: DesiredSkill[] = [];
    for (const id of [...targetIds].sort()) {
      const source = poolIds.has(id) ? 'pool' : tenantIds.has(id) ? 'tenant' : null;
      const sourceDir = source === 'pool'
        ? join(poolDir, id)
        : source === 'tenant' && tenantDir
          ? join(tenantDir, id)
          : null;
      if (!source || !sourceDir) continue;
      desired.push({
        id,
        source,
        sourceDir,
        digest: await this.getSourceDigest(sourceDir),
        ...(source === 'tenant' && user.tenantId ? { tenantId: user.tenantId } : {}),
      });
    }
    return desired;
  }

  private async resolveKnownManagedSkillIds(
    user: WorkspaceUser,
    previousSkills: Record<string, MaterializedSkillEntry>,
  ): Promise<Set<string>> {
    const known = new Set(Object.keys(previousSkills));
    for (const id of Object.keys(this.options.skillConfigStore.getPoolVisibility())) known.add(id);
    if (user.tenantId) {
      // 只依据当前用户 manifest、旧状态 fingerprint 迁移结果和本租户规则识别 managed，
      // 不能用所有租户的 skillId 并集推断来源，否则会误伤合法同名个人 Skill。
      for (const id of Object.keys(this.options.skillConfigStore.getTenantOwnSkillRules(user.tenantId))) {
        known.add(id);
      }
    }
    return known;
  }

  private async materializeScripts(input: {
    userCwd: string;
    stagingRoot: string;
    backupRoot: string;
    previousDigest?: string;
  }): Promise<string | undefined> {
    const source = resolveAgentPath(this.options.sharedDir, 'scripts');
    const digest = await this.resolveScriptsDigest();
    if (!digest) return undefined;
    const destination = agentScriptsDir(input.userCwd);
    const destinationIsRealDirectory = await isRealDirectory(destination);
    let unchanged = destinationIsRealDirectory && input.previousDigest === digest;
    if (destinationIsRealDirectory && !input.previousDigest) {
      try {
        unchanged = await computeDirectoryFingerprint(destination) === digest;
      } catch {
        unchanged = false;
      }
    }
    if (!unchanged) {
      await this.stageAndCommitDirectory({
        source,
        destination,
        stagingRoot: input.stagingRoot,
        backupRoot: input.backupRoot,
        name: 'scripts',
        expectedDigest: digest,
        validateSkillDocument: false,
      });
    }
    return digest;
  }

  private async resolveScriptsDigest(): Promise<string | undefined> {
    const source = resolveAgentPath(this.options.sharedDir, 'scripts');
    if (!await pathExists(source)) return undefined;
    return this.getSourceDigest(source);
  }

  private async stageAndCommitDirectory(input: {
    source: string;
    destination: string;
    stagingRoot: string;
    backupRoot: string;
    name: string;
    expectedDigest: string;
    validateSkillDocument: boolean;
  }): Promise<void> {
    await mkdir(input.stagingRoot, { recursive: true });
    const staged = join(input.stagingRoot, `${input.name}-${randomUUID()}`);
    try {
      await copyManagedDirectory(input.source, staged);
      if (input.validateSkillDocument) {
        const skillDoc = join(staged, 'SKILL.md');
        const info = await stat(skillDoc).catch(() => null);
        if (!info?.isFile()) throw new Error(`技能 ${input.name} 缺少 SKILL.md`);
      }
      const stagedDigest = await computeDirectoryFingerprint(staged);
      if (stagedDigest !== input.expectedDigest) {
        throw new Error(`技能 ${input.name} 在物化期间发生变化，请重试`);
      }
      await repairWorkspaceTreeAsync(staged);

      let backup: string | null = null;
      if (await pathExists(input.destination)) {
        backup = join(input.backupRoot, `${input.name}-${randomUUID()}`);
        await this.moveToBackup(input.destination, backup);
      }
      try {
        await rename(staged, input.destination);
      } catch (err) {
        if (backup && !await pathExists(input.destination)) {
          await rename(backup, input.destination).catch(() => undefined);
        }
        throw err;
      }
    } catch (err) {
      if (await pathExists(staged)) {
        await this.moveToBackup(
          staged,
          join(input.backupRoot, `failed-${input.name}-${randomUUID()}`),
        ).catch(() => undefined);
      }
      throw err;
    }
  }

  private async moveToBackup(source: string, backup: string): Promise<void> {
    await mkdir(dirname(backup), { recursive: true });
    await rename(source, backup);
  }

  private async getSourceDigest(sourceDir: string): Promise<string> {
    const configVersion = this.options.skillConfigStore.getConfigVersion();
    if (configVersion !== this.sourceDigestCacheVersion) {
      this.sourceDigestCacheVersion = configVersion;
      this.sourceDigestCache.clear();
    }
    const cached = this.sourceDigestCache.get(sourceDir);
    if (cached) return cached;
    const digest = await computeDirectoryFingerprint(sourceDir);
    this.sourceDigestCache.set(sourceDir, digest);
    return digest;
  }
}
