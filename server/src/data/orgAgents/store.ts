import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OrgAgentAudience, OrgAgentRecord, OrgAgentSummary, OrgAgentsFileData } from './types.js';

export interface CreateOrgAgentInput {
  tenantId: string;
  name: string;
  avatar?: string;
  instructions: string;
  allowedSkills: string[];
  audience: OrgAgentAudience;
  guardrail: OrgAgentRecord['guardrail'];
  enabled: boolean;
}

export type UpdateOrgAgentInput = Partial<Omit<CreateOrgAgentInput, 'tenantId'>>;

/** audience 三态匹配：用户是否被指派该专职 Agent */
export function isAssignedToOrgAgent(record: Pick<OrgAgentRecord, 'audience'>, username: string | undefined): boolean {
  const audience = record.audience;
  if (!audience || audience.exposure === 'all') return true;
  if (!username) return false;
  if (audience.exposure === 'allow_users') return audience.usernames.includes(username);
  return !audience.usernames.includes(username); // deny_users
}

export class OrgAgentStore {
  private agents: OrgAgentRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
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
      this.agents = Array.isArray(data.agents) ? data.agents : [];
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
      }));
  }

  async create(input: CreateOrgAgentInput, createdBy: string): Promise<OrgAgentRecord> {
    const now = new Date().toISOString();
    const record: OrgAgentRecord = {
      id: `oa-${randomUUID()}`,
      tenantId: input.tenantId,
      name: input.name,
      ...(input.avatar ? { avatar: input.avatar } : {}),
      instructions: input.instructions,
      allowedSkills: [...input.allowedSkills],
      audience: { exposure: input.audience.exposure, usernames: [...input.audience.usernames] },
      guardrail: { ...input.guardrail },
      enabled: input.enabled,
      createdAt: now,
      createdBy,
      updatedAt: now,
      updatedBy: createdBy,
    };
    this.agents.push(record);
    await this.persist();
    return { ...record };
  }

  async update(id: string, patch: UpdateOrgAgentInput, updatedBy: string): Promise<OrgAgentRecord | null> {
    const record = this.agents.find((agent) => agent.id === id);
    if (!record) return null;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.avatar !== undefined) {
      if (patch.avatar) record.avatar = patch.avatar;
      else delete record.avatar;
    }
    if (patch.instructions !== undefined) record.instructions = patch.instructions;
    if (patch.allowedSkills !== undefined) record.allowedSkills = [...patch.allowedSkills];
    if (patch.audience !== undefined) {
      record.audience = { exposure: patch.audience.exposure, usernames: [...patch.audience.usernames] };
    }
    if (patch.guardrail !== undefined) record.guardrail = { ...patch.guardrail };
    if (patch.enabled !== undefined) record.enabled = patch.enabled;
    record.updatedAt = new Date().toISOString();
    record.updatedBy = updatedBy;
    await this.persist();
    return { ...record };
  }

  async remove(id: string): Promise<boolean> {
    const index = this.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return false;
    this.agents.splice(index, 1);
    await this.persist();
    return true;
  }
}
