import { readFileSync } from 'node:fs';

import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../../data/tenants/types.js';
import type { DirectoryUserReader, DirectoryUserSourceRecord } from './projection.js';

export interface UsersFileDirectoryReaderOptions {
  filePath: string;
  initialUsers: readonly DirectoryUserSourceRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStoredUser(
  value: unknown,
  index: number,
): asserts value is Record<string, unknown> & {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  createdAt: string;
  createdBy: string;
  updatedAt: string;
} {
  if (!isRecord(value)) throw new Error(`users[${index}] 必须是对象`);
  for (const field of ['id', 'username', 'passwordHash', 'createdAt', 'createdBy', 'updatedAt']) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      throw new Error(`users[${index}].${field} 必须是非空字符串`);
    }
  }
  if (value.role !== 'admin' && value.role !== 'user') {
    throw new Error(`users[${index}].role 非法`);
  }
  for (const field of ['realName', 'tenantId']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error(`users[${index}].${field} 必须是字符串`);
    }
  }
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    throw new Error(`users[${index}].disabled 必须是布尔值`);
  }
}

function parseSnapshot(raw: string): DirectoryUserSourceRecord[] {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || data.version !== 1) throw new Error('版本或根结构非法');
  if (!Array.isArray(data.users)) throw new Error('users 必须是数组');
  data.users.forEach(assertStoredUser);
  return data.users.map((user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    tenantId:
      typeof user.tenantId === 'string' && user.tenantId !== ''
        ? user.tenantId
        : user.username === 'admin' && user.role === 'admin'
          ? DEFAULT_TENANT_ID
          : LEGACY_TENANT_ID,
    ...(typeof user.realName === 'string' ? { realName: user.realName } : {}),
    ...(typeof user.disabled === 'boolean' ? { disabled: user.disabled } : {}),
  }));
}

/**
 * 目录专用的只读 users.json 快照。候选文件必须完整解析和校验后才原子替换内存态；
 * 任何失败都会保留上一版，防止目录投影把损坏文件解释为全员离职。
 */
export class UsersFileDirectoryReader implements DirectoryUserReader {
  private users: DirectoryUserSourceRecord[];

  constructor(private readonly options: UsersFileDirectoryReaderOptions) {
    this.users = options.initialUsers.map((user) => ({ ...user }));
  }

  reload(): void {
    try {
      const candidate = parseSnapshot(readFileSync(this.options.filePath, 'utf8'));
      this.users = candidate;
    } catch (error) {
      throw new Error('共享 users.json 刷新失败，已保留上一版用户快照', { cause: error });
    }
  }

  listAll(): readonly DirectoryUserSourceRecord[] {
    return this.users;
  }
}
