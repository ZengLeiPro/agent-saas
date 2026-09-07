import { createHash, randomBytes } from 'node:crypto';

import type { PgDirectoryGroupStore } from '../../data/directoryGroups/store.js';
import type { PgMembershipStore } from '../../data/memberships/store.js';
import type { UserStore } from '../../data/users/store.js';
import type { GovernanceDirectorySource } from '../directory/projection.js';

const PHONE_PATTERN = /^1[3-9]\d{9}$/u;

export interface KyAppMemberImportRow {
  row: number;
  name: string;
  phone: string;
  departmentPath: string;
  employeeNo?: string;
}

export interface KyAppMemberImportRowResult {
  row: number;
  phone: string;
  status: 'created' | 'existing' | 'rejected';
  userId?: string;
  code?:
    | 'invalid_phone'
    | 'duplicate_phone'
    | 'cross_tenant_phone'
    | 'disabled_user'
    | 'invalid_department';
  message?: string;
}

export interface KyAppMemberImportReport {
  total: number;
  created: number;
  existing: number;
  rejected: number;
  rows: KyAppMemberImportRowResult[];
}

export interface KyAppMemberImporterOptions {
  users: UserStore;
  memberships: PgMembershipStore;
  groups: PgDirectoryGroupStore;
  directory: GovernanceDirectorySource;
}

function groupId(tenantId: string, path: string): string {
  return `csv_${createHash('sha256').update(`${tenantId}\0${path}`).digest('hex').slice(0, 32)}`;
}

function parseDepartmentPath(raw: string): string[] | null {
  const segments = raw
    .split('/')
    .map((value) => value.trim())
    .filter(Boolean);
  if (segments.length === 0 || segments.some((value) => value.length > 100)) return null;
  return segments;
}

export class KyAppMemberImporter {
  constructor(private readonly options: KyAppMemberImporterOptions) {}

  async import(
    tenantId: string,
    actorUserId: string,
    rows: KyAppMemberImportRow[],
  ): Promise<KyAppMemberImportReport> {
    const results: KyAppMemberImportRowResult[] = [];
    const seen = new Set<string>();
    const groupMembers = new Map<string, Set<string>>();
    const groupMeta = new Map<string, { displayName: string; parentGroupId?: string }>();
    const desiredGroupsByUser = new Map<string, Set<string>>();

    for (const input of rows) {
      const phone = input.phone.trim();
      if (!PHONE_PATTERN.test(phone)) {
        results.push({
          row: input.row,
          phone,
          status: 'rejected',
          code: 'invalid_phone',
          message: '手机号格式非法',
        });
        continue;
      }
      if (seen.has(phone)) {
        results.push({
          row: input.row,
          phone,
          status: 'rejected',
          code: 'duplicate_phone',
          message: '同一 CSV 内手机号重复，保留首次出现行',
        });
        continue;
      }
      seen.add(phone);
      const departments = parseDepartmentPath(input.departmentPath);
      if (!departments) {
        results.push({
          row: input.row,
          phone,
          status: 'rejected',
          code: 'invalid_department',
          message: '部门路径必须为非空的 / 分隔层级',
        });
        continue;
      }

      const owners = this.options.users.findAllByPhone(phone);
      const existing = owners.find((user) => user.tenantId === tenantId);
      if (owners.some((user) => user.tenantId !== tenantId)) {
        results.push({
          row: input.row,
          phone,
          status: 'rejected',
          code: 'cross_tenant_phone',
          message: '手机号已属于其他组织，禁止静默复用身份',
        });
        continue;
      }
      if (existing?.disabled) {
        results.push({
          row: input.row,
          phone,
          status: 'rejected',
          code: 'disabled_user',
          message: '现有账号已停用，批量导入不会自动恢复',
        });
        continue;
      }

      const user =
        existing ??
        (await this.options.users.create({
          username: phone,
          password: randomBytes(24).toString('base64url'),
          role: 'user',
          realName: input.name.trim(),
          phone,
          phoneVerifiedAt: new Date().toISOString(),
          tenantId,
          createdBy: actorUserId,
        }));
      const membership = await this.options.memberships.getMembership(tenantId, user.id);
      if (!membership) {
        await this.options.memberships.createMembership({
          tenantId,
          userId: user.id,
          persona: 'member',
          createdBy: actorUserId,
        });
      }
      if (input.employeeNo?.trim()) {
        await this.options.directory.setEmployeeNo(tenantId, user.id, input.employeeNo.trim());
      }

      let path = '';
      let parentGroupId: string | undefined;
      const desiredGroups = new Set<string>();
      for (const segment of departments) {
        path = path ? `${path}/${segment}` : segment;
        const id = groupId(tenantId, path);
        desiredGroups.add(id);
        groupMeta.set(id, { displayName: segment, ...(parentGroupId ? { parentGroupId } : {}) });
        const members = groupMembers.get(id) ?? new Set<string>();
        members.add(user.id);
        groupMembers.set(id, members);
        parentGroupId = id;
      }
      desiredGroupsByUser.set(user.id, desiredGroups);
      results.push({
        row: input.row,
        phone,
        status: existing ? 'existing' : 'created',
        userId: user.id,
      });
    }

    for (const group of await this.options.groups.listGroups(tenantId)) {
      if (group.source !== 'governance' || !group.groupId.startsWith('csv_')) continue;
      const existingMembers = await this.options.groups.listMembers(tenantId, group.groupId);
      if (!existingMembers.some((member) => desiredGroupsByUser.has(member.userId))) continue;
      if (!groupMeta.has(group.groupId)) {
        groupMeta.set(group.groupId, {
          displayName: group.displayName,
          ...(group.parentGroupId ? { parentGroupId: group.parentGroupId } : {}),
        });
      }
    }

    for (const [id, meta] of groupMeta) {
      const existingMembers = await this.options.groups.listMembers(tenantId, id);
      const memberUserIds = new Set(
        existingMembers
          .filter((member) => {
            const desired = desiredGroupsByUser.get(member.userId);
            return !desired || desired.has(id);
          })
          .map((member) => member.userId),
      );
      for (const userId of groupMembers.get(id) ?? []) memberUserIds.add(userId);
      await this.options.groups.upsertProjection({
        groupId: id,
        tenantId,
        source: 'governance',
        displayName: meta.displayName,
        ...(meta.parentGroupId ? { parentGroupId: meta.parentGroupId } : {}),
        status: 'active',
        memberUserIds: [...memberUserIds].sort(),
        sourceRevision: `csv:${createHash('sha256')
          .update([...memberUserIds].sort().join('\0'))
          .digest('hex')}`,
      });
    }

    return {
      total: results.length,
      created: results.filter((row) => row.status === 'created').length,
      existing: results.filter((row) => row.status === 'existing').length,
      rejected: results.filter((row) => row.status === 'rejected').length,
      rows: results,
    };
  }
}
