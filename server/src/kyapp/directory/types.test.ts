/**
 * 附录 L 字段白名单与 PII 纪律（§3.4 / §3.6）的单元合约。
 * 这条测试的存在意义：投影结果里出现任何手机号/邮箱/凭据字样的键，CI 立刻红。
 */
import { describe, expect, it } from 'vitest';

import {
  DIRECTORY_FORBIDDEN_FIELD_PATTERN,
  DIRECTORY_GROUP_FIELDS,
  DIRECTORY_USER_FIELDS,
  directoryEntityDigest,
  toDirectoryEvent,
  toDirectoryGroup,
  toDirectoryUser,
} from './types.js';

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      collectKeys(child, into);
    }
  }
  return into;
}

describe('目录用户投影（字段白名单）', () => {
  it('只输出附录 L 的六个字段，且不含任何 PII/凭据键', () => {
    const projected = toDirectoryUser({
      userId: 'u-1',
      displayNameCandidates: ['张三', 'zhangsan'],
      employeeNo: 'E-0001',
      accountDisabled: false,
      membershipStatus: 'active',
      isTenantAdmin: true,
      groupIds: ['g-2', 'g-1', 'g-2'],
    });
    expect(Object.keys(projected).sort()).toEqual([
      'displayName',
      'employeeNo',
      'groupIds',
      'isTenantAdmin',
      'status',
      'userId',
    ]);
    for (const key of Object.keys(projected)) {
      expect(DIRECTORY_USER_FIELDS as readonly string[]).toContain(key);
    }
    for (const key of collectKeys(projected)) {
      expect(key).not.toMatch(DIRECTORY_FORBIDDEN_FIELD_PATTERN);
    }
    // 分组去重并排序，保证同一事实每次投影出同一指纹。
    expect(projected.groupIds).toEqual(['g-1', 'g-2']);
  });

  it('源记录带手机号/邮箱/密码哈希时，投影结果里一个都不出现', () => {
    const contaminated = {
      userId: 'u-2',
      displayNameCandidates: ['李四'],
      isTenantAdmin: false,
      groupIds: [],
      phone: '13800000000',
      phoneVerifiedAt: '2026-01-01T00:00:00.000Z',
      email: 'li@example.com',
      passwordHash: 'argon2id$fake',
      serviceToken: 'Bearer fake',
      apiKey: 'sk-fake',
    };
    const projected = toDirectoryUser(contaminated);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('13800000000');
    expect(serialized).not.toContain('li@example.com');
    expect(serialized).not.toContain('argon2id');
    expect(serialized).not.toContain('sk-fake');
    for (const key of collectKeys(projected)) {
      expect(key).not.toMatch(DIRECTORY_FORBIDDEN_FIELD_PATTERN);
    }
  });

  it('employeeNo 为空时整个键省略；status 由账号或成员任一停用即为 disabled', () => {
    expect(
      toDirectoryUser({
        userId: 'u-3',
        displayNameCandidates: [null, '  '],
        employeeNo: '   ',
        isTenantAdmin: false,
        groupIds: [],
      }),
    ).toEqual({
      userId: 'u-3',
      displayName: 'u-3',
      status: 'active',
      isTenantAdmin: false,
      groupIds: [],
    });
    expect(
      toDirectoryUser({
        userId: 'u-4',
        displayNameCandidates: ['王五'],
        accountDisabled: true,
        isTenantAdmin: false,
        groupIds: [],
      }).status,
    ).toBe('disabled');
    expect(
      toDirectoryUser({
        userId: 'u-5',
        displayNameCandidates: ['赵六'],
        membershipStatus: 'disabled',
        isTenantAdmin: false,
        groupIds: [],
      }).status,
    ).toBe('disabled');
  });

  it('displayName ≤ 40、employeeNo ≤ 32，超长按附录 L 截断而不是让消费端判红', () => {
    const projected = toDirectoryUser({
      userId: 'u-6',
      displayNameCandidates: ['名'.repeat(80)],
      employeeNo: 'E'.repeat(80),
      isTenantAdmin: false,
      groupIds: [],
    });
    expect(projected.displayName).toHaveLength(40);
    expect(projected.employeeNo).toHaveLength(32);
  });
});

describe('目录分组投影与事件还原', () => {
  it('分组只输出四个字段，parentGroupId 为空即省略', () => {
    const group = toDirectoryGroup({
      groupId: 'g-1',
      displayNameCandidates: ['研发部'],
      parentGroupId: null,
      status: 'active',
    });
    expect(Object.keys(group).sort()).toEqual(['displayName', 'groupId', 'status']);
    for (const key of Object.keys(group)) {
      expect(DIRECTORY_GROUP_FIELDS as readonly string[]).toContain(key);
    }
    expect(
      toDirectoryGroup({
        groupId: 'g-2',
        displayNameCandidates: ['一组'],
        parentGroupId: 'g-1',
        status: 'disabled',
      }),
    ).toEqual({ groupId: 'g-2', displayName: '一组', parentGroupId: 'g-1', status: 'disabled' });
  });

  it('指纹只看白名单字段，字段顺序不同不影响结果；任一字段变化即变指纹', () => {
    const left = toDirectoryUser({
      userId: 'u-1',
      displayNameCandidates: ['张三'],
      isTenantAdmin: false,
      groupIds: ['a', 'b'],
    });
    const right = toDirectoryUser({
      userId: 'u-1',
      displayNameCandidates: ['张三'],
      isTenantAdmin: false,
      groupIds: ['b', 'a'],
    });
    expect(directoryEntityDigest(left)).toBe(directoryEntityDigest(right));
    const changed = toDirectoryUser({
      userId: 'u-1',
      displayNameCandidates: ['张三'],
      isTenantAdmin: true,
      groupIds: ['a', 'b'],
    });
    expect(directoryEntityDigest(changed)).not.toBe(directoryEntityDigest(left));
  });

  it('变更日志行按 type 还原成附录 L 的判别联合', () => {
    const user = toDirectoryUser({
      userId: 'u-1',
      displayNameCandidates: ['张三'],
      isTenantAdmin: false,
      groupIds: [],
    });
    const base = {
      tenantId: 't-1',
      source: 'governance' as const,
      occurredAt: '2026-09-06T00:00:00.000Z',
    };
    expect(
      toDirectoryEvent({
        ...base,
        seq: 1,
        eventId: 'e1',
        type: 'user.upsert',
        entityId: 'u-1',
        payload: user,
      }),
    ).toEqual({ seq: 1, eventId: 'e1', type: 'user.upsert', user });
    expect(
      toDirectoryEvent({
        ...base,
        seq: 2,
        eventId: 'e2',
        type: 'user.remove',
        entityId: 'u-1',
        payload: {},
      }),
    ).toEqual({ seq: 2, eventId: 'e2', type: 'user.remove', userId: 'u-1' });
    expect(
      toDirectoryEvent({
        ...base,
        seq: 4,
        eventId: 'e4',
        type: 'group.remove',
        entityId: 'g-1',
        payload: {},
      }),
    ).toEqual({ seq: 4, eventId: 'e4', type: 'group.remove', groupId: 'g-1' });
  });
});
