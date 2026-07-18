import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrgAgentAudience, OrgAgentRecord, OrgAgentSummary, OrgAgentsFileData } from './types.js';

export interface CreateOrgAgentInput {
  tenantId: string;
  name: string;
  avatar?: string;
  description?: string;
  starterPrompts?: string[];
  instructions: string;
  allowedSkills: string[];
  /** ★ 新增（2026-07-18）：挂载租户知识库 id 列表，optional 向后兼容 */
  allowedKnowledge?: string[];
  audience: OrgAgentAudience;
  guardrail: OrgAgentRecord['guardrail'];
  enabled: boolean;
}

export type UpdateOrgAgentInput = Partial<Omit<CreateOrgAgentInput, 'tenantId'>> & {
  /** 仅上传接口写入（伴随 avatar 路径值） */
  avatarVersion?: number;
};

/** audience 三态匹配：用户是否被指派该专职 Agent */
export function isAssignedToOrgAgent(record: Pick<OrgAgentRecord, 'audience'>, username: string | undefined): boolean {
  const audience = record.audience;
  if (!audience || audience.exposure === 'all') return true;
  if (!username) return false;
  if (audience.exposure === 'allow_users') return audience.usernames.includes(username);
  return !audience.usernames.includes(username); // deny_users
}

/**
 * 规范化 audience：合法化必填字段，同时防御性保留 optional 部门/角色白名单
 * （2026-07-18 企业专家目录 MVP 新增字段，蓝图 v2 § 4.1.1）
 */
function normalizeAudience(audience: unknown): OrgAgentAudience {
  const raw = (audience ?? {}) as Partial<OrgAgentAudience>;
  const usernames = Array.isArray(raw.usernames)
    ? raw.usernames.filter((item): item is string => typeof item === 'string')
    : [];
  const result: OrgAgentAudience = {
    exposure: raw.exposure === 'allow_users' || raw.exposure === 'deny_users' ? raw.exposure : 'all',
    usernames,
  };
  if (Array.isArray(raw.departmentIds)) {
    const departmentIds = raw.departmentIds.filter((item): item is string => typeof item === 'string');
    if (departmentIds.length > 0) result.departmentIds = departmentIds;
  }
  if (Array.isArray(raw.roles)) {
    const roles = raw.roles.filter((item): item is string => typeof item === 'string');
    if (roles.length > 0) result.roles = roles;
  }
  return result;
}

export class OrgAgentStore {
  private agents: OrgAgentRecord[] = [];
  private filePath: string;
  /** 写队列尾（2026-07 审查 F6）：「内存变更 + persist」整体串行，防并发写 last-write-wins 丢更新 */
  private writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** 写操作入队：调用方 await 的是本次 op 的结果/异常；队列尾吞错避免一次失败卡死后续写 */
  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(op);
    this.writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.agents = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: OrgAgentsFileData = JSON.parse(raw);
      this.agents = Array.isArray(data.agents)
        ? data.agents.map((agent) => ({
            ...agent,
            description: typeof agent.description === 'string' ? agent.description : '',
            starterPrompts: Array.isArray(agent.starterPrompts)
              ? agent.starterPrompts.filter((item): item is string => typeof item === 'string')
              : [],
            // ★ 新增 optional 字段默认值（2026-07-18 企业专家目录 MVP）
            // 旧记录缺字段时 undefined，保持"未设置"语义（避免 [] 与"未启用"歧义）
            ...(Array.isArray(agent.allowedKnowledge)
              ? {
                  allowedKnowledge: agent.allowedKnowledge.filter(
                    (item): item is string => typeof item === 'string',
                  ),
                }
              : {}),
            audience: normalizeAudience(agent.audience),
          }))
        : [];
    } catch {
      this.agents = [];
    }
  }

  private async persist(): Promise<void> {
    const data: OrgAgentsFileData = { version: 1, agents: this.agents };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.org-agents.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  get(id: string): OrgAgentRecord | undefined {
    return this.agents.find((agent) => agent.id === id);
  }

  listAll(): OrgAgentRecord[] {
    return [...this.agents];
  }

  listByTenant(tenantId: string): OrgAgentRecord[] {
    return this.agents.filter((agent) => agent.tenantId === tenantId);
  }

  /** 员工侧数据源：本租户 enabled + 被指派的裁剪视图 */
  listForUser(tenantId: string, username: string | undefined): OrgAgentSummary[] {
    return this.listByTenant(tenantId)
      .filter((agent) => agent.enabled && isAssignedToOrgAgent(agent, username))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        ...(agent.avatar ? { avatar: agent.avatar } : {}),
        ...(agent.avatarVersion ? { avatarVersion: agent.avatarVersion } : {}),
        description: agent.description,
        starterPrompts: [...agent.starterPrompts],
        skillCount: agent.allowedSkills.length,
      }));
  }

  async create(input: CreateOrgAgentInput, createdBy: string): Promise<OrgAgentRecord> {
    return this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      const record: OrgAgentRecord = {
        id: `oa-${randomUUID()}`,
        tenantId: input.tenantId,
        name: input.name,
        ...(input.avatar ? { avatar: input.avatar } : {}),
        description: input.description ?? '',
        starterPrompts: [...(input.starterPrompts ?? [])],
        instructions: input.instructions,
        allowedSkills: [...input.allowedSkills],
        // ★ 新增（2026-07-18）：allowedKnowledge 仅在输入非空数组时写入，
        // 保持"未设置"与"空数组"语义一致（optional，向后兼容旧记录）
        ...(input.allowedKnowledge && input.allowedKnowledge.length > 0
          ? { allowedKnowledge: [...input.allowedKnowledge] }
          : {}),
        audience: {
          exposure: input.audience.exposure,
          usernames: [...input.audience.usernames],
          ...(input.audience.departmentIds && input.audience.departmentIds.length > 0
            ? { departmentIds: [...input.audience.departmentIds] }
            : {}),
          ...(input.audience.roles && input.audience.roles.length > 0
            ? { roles: [...input.audience.roles] }
            : {}),
        },
        guardrail: { ...input.guardrail },
        enabled: input.enabled,
        createdAt: now,
        createdBy,
        updatedAt: now,
        updatedBy: createdBy,
      };
      this.agents.push(record);
      try {
        await this.persist();
      } catch (err) {
        // persist 失败回滚内存变更，避免内存/磁盘分叉
        this.agents = this.agents.filter((agent) => agent.id !== record.id);
        throw err;
      }
      return { ...record };
    });
  }

  async update(id: string, patch: UpdateOrgAgentInput, updatedBy: string): Promise<OrgAgentRecord | null> {
    return this.enqueueWrite(async () => {
      const index = this.agents.findIndex((agent) => agent.id === id);
      if (index < 0) return null;
      const record = this.agents[index];
      const snapshot = structuredClone(record);
      if (patch.name !== undefined) record.name = patch.name;
      if (patch.avatar !== undefined) {
        if (patch.avatar) record.avatar = patch.avatar;
        else {
          delete record.avatar;
          delete record.avatarVersion;
        }
      }
      if (patch.avatarVersion !== undefined) record.avatarVersion = patch.avatarVersion;
      if (patch.description !== undefined) record.description = patch.description;
      if (patch.starterPrompts !== undefined) record.starterPrompts = [...patch.starterPrompts];
      if (patch.instructions !== undefined) record.instructions = patch.instructions;
      if (patch.allowedSkills !== undefined) record.allowedSkills = [...patch.allowedSkills];
      // ★ 新增（2026-07-18）：allowedKnowledge 可清空（传空数组 → 删除字段保持一致语义）
      if (patch.allowedKnowledge !== undefined) {
        if (patch.allowedKnowledge.length > 0) {
          record.allowedKnowledge = [...patch.allowedKnowledge];
        } else {
          delete record.allowedKnowledge;
        }
      }
      if (patch.audience !== undefined) {
        const nextAudience: OrgAgentAudience = {
          exposure: patch.audience.exposure,
          usernames: [...patch.audience.usernames],
        };
        if (patch.audience.departmentIds && patch.audience.departmentIds.length > 0) {
          nextAudience.departmentIds = [...patch.audience.departmentIds];
        }
        if (patch.audience.roles && patch.audience.roles.length > 0) {
          nextAudience.roles = [...patch.audience.roles];
        }
        record.audience = nextAudience;
      }
      if (patch.guardrail !== undefined) record.guardrail = { ...patch.guardrail };
      if (patch.enabled !== undefined) record.enabled = patch.enabled;
      record.updatedAt = new Date().toISOString();
      record.updatedBy = updatedBy;
      try {
        await this.persist();
      } catch (err) {
        // persist 失败回滚旧值快照
        this.agents[index] = snapshot;
        throw err;
      }
      return { ...record };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const index = this.agents.findIndex((agent) => agent.id === id);
      if (index < 0) return false;
      const [removed] = this.agents.splice(index, 1);
      try {
        await this.persist();
      } catch (err) {
        // persist 失败回滚删除
        this.agents.splice(index, 0, removed);
        throw err;
      }
      return true;
    });
  }
}
