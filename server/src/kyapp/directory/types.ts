/**
 * WP2b 组织目录（规范 §3.6、附录 L）的服务端类型与**字段白名单投影**。
 *
 * 附录 L 的 `user` / `group` 都是 `additionalProperties:false`，多一个字段消费端
 * `validateDirectorySnapshot` 就判红；但那只是回归网，不是防线。本模块的硬约束是：
 * **投影函数逐字段显式赋值，任何情况下都不 spread 源记录**，因此手机号、密码哈希、
 * 凭据等字段在类型层与运行期都不可能溜进快照或变更流（§3.4 PII 纪律）。
 */
import { createHash } from 'node:crypto';

import type {
  DirectoryEvent,
  DirectoryGroup,
  DirectoryStatus,
  DirectoryUser,
} from '@kaiyan/ky-app-contract';

export type { DirectoryEvent, DirectoryGroup, DirectoryStatus, DirectoryUser };

/** 附录 L `user` 允许出现的全部键，顺序即投影函数的赋值顺序。 */
export const DIRECTORY_USER_FIELDS = [
  'userId',
  'displayName',
  'employeeNo',
  'status',
  'isTenantAdmin',
  'groupIds',
] as const;

/** 附录 L `group` 允许出现的全部键。 */
export const DIRECTORY_GROUP_FIELDS = [
  'groupId',
  'displayName',
  'parentGroupId',
  'status',
] as const;

/**
 * 禁止出现在目录输出里的键名（§3.6「不返回手机号/邮箱」+ §3.4 凭据纪律）。
 * 单测用它对投影结果做深度断言；生产代码不依赖它做过滤——过滤靠白名单赋值。
 */
export const DIRECTORY_FORBIDDEN_FIELD_PATTERN =
  /(phone|mobile|email|password|passwd|token|secret|credential|apikey|api_key)/iu;

/** 附录 L 的长度上限。 */
export const DIRECTORY_DISPLAY_NAME_MAX = 40;
export const DIRECTORY_EMPLOYEE_NO_MAX = 32;

export type DirectoryEntityType = 'user' | 'group';
export type DirectoryChangeType = DirectoryEvent['type'];
export type DirectorySourceId = 'governance' | 'dingtalk';

export const DIRECTORY_CHANGE_TYPES = [
  'user.upsert',
  'user.remove',
  'group.upsert',
  'group.remove',
] as const satisfies readonly DirectoryChangeType[];

/** 变更日志表的一行。`payload` 只装附录 L 的实体，不装任何源端原始记录。 */
export interface DirectoryChangeRecord {
  seq: number;
  eventId: string;
  tenantId: string;
  source: DirectorySourceId;
  type: DirectoryChangeType;
  entityId: string;
  payload: DirectoryUser | DirectoryGroup | Record<string, never>;
  occurredAt: string;
}

/**
 * 源端提供给投影函数的用户事实。字段刻意只留投影需要的这几项：
 * 调用方必须自己从源记录里挑出来，避免「把整条 UserRecord 递进来」的诱惑。
 */
export interface DirectoryUserFacts {
  userId: string;
  /** 展示名候选，按顺序取第一个非空值（realName → username → userId）。 */
  displayNameCandidates: readonly (string | null | undefined)[];
  employeeNo?: string | null;
  /** 账号是否停用（users.json 的 `disabled`）。 */
  accountDisabled?: boolean;
  /** 组织成员状态；缺失（尚未投影出 membership）按 active 处理。 */
  membershipStatus?: 'active' | 'disabled' | null;
  isTenantAdmin: boolean;
  groupIds: readonly string[];
}

export interface DirectoryGroupFacts {
  groupId: string;
  displayNameCandidates: readonly (string | null | undefined)[];
  parentGroupId?: string | null;
  status: DirectoryStatus;
}

function firstNonEmpty(
  candidates: readonly (string | null | undefined)[],
  fallback: string,
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

/** 附录 L 的 `maxLength` 是硬校验，超长必须在服务端截断，不能指望消费端宽容。 */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * 用户投影：**逐字段显式赋值**，`employeeNo` 只在非空时出现（附录 L 里它是可选键）。
 * 这是快照与变更流里 user 的唯一构造入口。
 */
export function toDirectoryUser(facts: DirectoryUserFacts): DirectoryUser {
  const employeeNo = facts.employeeNo?.trim();
  const disabled = facts.accountDisabled === true || facts.membershipStatus === 'disabled';
  const user: DirectoryUser = {
    userId: facts.userId,
    displayName: clamp(
      firstNonEmpty(facts.displayNameCandidates, facts.userId),
      DIRECTORY_DISPLAY_NAME_MAX,
    ),
    status: disabled ? 'disabled' : 'active',
    isTenantAdmin: facts.isTenantAdmin === true,
    groupIds: [...new Set(facts.groupIds)].sort(),
  };
  if (employeeNo) user.employeeNo = clamp(employeeNo, DIRECTORY_EMPLOYEE_NO_MAX);
  return user;
}

/** 分组投影：`parentGroupId` 为空时直接省略（附录 L 允许 string | null，省略更省字节）。 */
export function toDirectoryGroup(facts: DirectoryGroupFacts): DirectoryGroup {
  const parentGroupId = facts.parentGroupId?.trim();
  const group: DirectoryGroup = {
    groupId: facts.groupId,
    displayName: clamp(
      firstNonEmpty(facts.displayNameCandidates, facts.groupId),
      DIRECTORY_DISPLAY_NAME_MAX,
    ),
    status: facts.status,
  };
  if (parentGroupId) group.parentGroupId = parentGroupId;
  return group;
}

/**
 * 实体指纹：投影器靠它判断「这次和上次投影出来的到底一不一样」。
 * 按白名单键名排序后序列化，键序不影响结果，`undefined` 与缺键等价。
 */
export function directoryEntityDigest(entity: DirectoryUser | DirectoryGroup): string {
  const keys = 'userId' in entity ? DIRECTORY_USER_FIELDS : DIRECTORY_GROUP_FIELDS;
  const canonical: unknown[] = [];
  for (const key of keys) {
    const value = (entity as unknown as Record<string, unknown>)[key];
    canonical.push(value === undefined ? null : value);
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** 把变更日志行还原成附录 L 的事件（判别联合，按 type 分支构造）。 */
export function toDirectoryEvent(record: DirectoryChangeRecord): DirectoryEvent {
  const base = { seq: record.seq, eventId: record.eventId };
  switch (record.type) {
    case 'user.upsert':
      return { ...base, type: 'user.upsert', user: record.payload as DirectoryUser };
    case 'user.remove':
      return { ...base, type: 'user.remove', userId: record.entityId };
    case 'group.upsert':
      return { ...base, type: 'group.upsert', group: record.payload as DirectoryGroup };
    case 'group.remove':
      return { ...base, type: 'group.remove', groupId: record.entityId };
  }
}
