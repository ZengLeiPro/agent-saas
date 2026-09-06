import { describe, expect, it } from 'vitest';

import {
  DIRECTORY_SNAPSHOT_FIELD_WHITELIST,
  DIRECTORY_SNAPSHOT_PAGE_SIZE,
  MemoryDirectorySnapshotSource,
  pickDirectoryGroup,
  pickDirectoryUser,
} from './snapshot.js';
import {
  DIRECTORY_FORBIDDEN_FIELD_PATTERN,
  DIRECTORY_GROUP_FIELDS,
  DIRECTORY_USER_FIELDS,
  type DirectoryGroup,
  type DirectoryUser,
} from './types.js';

function user(id: string): DirectoryUser {
  return {
    userId: id,
    displayName: `员工 ${id}`,
    status: 'active',
    isTenantAdmin: false,
    groupIds: ['g-root'],
  };
}

function group(id: string): DirectoryGroup {
  return { groupId: id, displayName: `部门 ${id}`, status: 'active' };
}

describe('快照分页（§3.6 / 附录 L）', () => {
  it('页大小固定，分组排在用户之前，逐页拼回完整目录且不重不漏', async () => {
    const source = new MemoryDirectorySnapshotSource();
    source.set('t_demo', {
      snapshotSeq: 77,
      users: ['u-3', 'u-1', 'u-2'].map(user),
      groups: ['g-b', 'g-a'].map(group),
    });

    const pages = [];
    for (let page = 0; page < 10; page += 1) {
      const result = await source.readPage({ tenantId: 't_demo', page, pageSize: 2 });
      pages.push(result);
      if (!result.hasMore) break;
    }
    // 5 个实体 / 每页 2 → 3 页。
    expect(pages).toHaveLength(3);
    expect(pages.every((item) => item.snapshotSeq === 77)).toBe(true);
    expect(pages.map((item) => [item.groups.length, item.users.length])).toEqual([
      [2, 0],
      [0, 2],
      [0, 1],
    ]);
    expect(pages.flatMap((item) => item.groups.map((entry) => entry.groupId))).toEqual([
      'g-a',
      'g-b',
    ]);
    expect(pages.flatMap((item) => item.users.map((entry) => entry.userId))).toEqual([
      'u-1',
      'u-2',
      'u-3',
    ]);
    expect(pages[pages.length - 1]!.hasMore).toBe(false);
  });

  it('空组织返回空快照且 hasMore=false；未知组织同样不报错', async () => {
    const source = new MemoryDirectorySnapshotSource();
    source.set('t_empty', { snapshotSeq: 0, users: [], groups: [] });
    for (const tenantId of ['t_empty', 't_unknown']) {
      await expect(source.readPage({ tenantId, page: 0 })).resolves.toEqual({
        snapshotSeq: 0,
        users: [],
        groups: [],
        hasMore: false,
      });
    }
  });

  it('越界页码返回空页而不是报错（消费端最多多打一次）', async () => {
    const source = new MemoryDirectorySnapshotSource();
    source.set('t_demo', { snapshotSeq: 5, users: [user('u-1')], groups: [] });
    const page = await source.readPage({ tenantId: 't_demo', page: 9, pageSize: 2 });
    expect(page).toMatchObject({ snapshotSeq: 5, users: [], groups: [], hasMore: false });
  });

  it('白名单挑选：源载荷里的手机号 / 凭据字段一个都出不来', () => {
    const dirty = {
      userId: 'u-1',
      displayName: '张三',
      employeeNo: 'E-0007',
      status: 'disabled',
      isTenantAdmin: true,
      groupIds: ['g-a', 42, 'g-b'],
      phone: '13800000000',
      email: 'zhangsan@example.com',
      passwordHash: '$argon2id$x',
      apiKey: 'sk-live-xxx',
    } as unknown as Record<string, unknown>;
    const picked = pickDirectoryUser(dirty);
    expect(Object.keys(picked).sort()).toEqual([...DIRECTORY_USER_FIELDS].sort());
    expect(picked).toEqual({
      userId: 'u-1',
      displayName: '张三',
      employeeNo: 'E-0007',
      status: 'disabled',
      isTenantAdmin: true,
      // 非字符串的 groupId 被丢掉，不会把脏数据带给消费端。
      groupIds: ['g-a', 'g-b'],
    });
    expect(JSON.stringify(picked)).not.toMatch(DIRECTORY_FORBIDDEN_FIELD_PATTERN);
    expect(JSON.stringify(picked)).not.toContain('13800000000');
  });

  it('分组白名单：parentGroupId 为空即省键，多余键被丢弃', () => {
    expect(
      pickDirectoryGroup({ groupId: 'g-a', displayName: '研发', status: 'active', owner: 'u-1' }),
    ).toEqual({ groupId: 'g-a', displayName: '研发', status: 'active' });
    const nested = pickDirectoryGroup({
      groupId: 'g-b',
      displayName: '前端',
      parentGroupId: 'g-a',
      status: 'disabled',
    });
    expect(nested).toEqual({
      groupId: 'g-b',
      displayName: '前端',
      parentGroupId: 'g-a',
      status: 'disabled',
    });
    expect(Object.keys(nested).sort()).toEqual([...DIRECTORY_GROUP_FIELDS].sort());
  });

  it('未知 status 一律回落 active，绝不把库里的脏值透传成附录 L 的枚举外取值', () => {
    expect(pickDirectoryUser({ userId: 'u', status: 'weird' }).status).toBe('active');
    expect(pickDirectoryGroup({ groupId: 'g', status: null }).status).toBe('active');
  });

  it('页大小常量与白名单常量对外可见，供路由与交叉测试引用同一份口径', () => {
    expect(DIRECTORY_SNAPSHOT_PAGE_SIZE).toBe(200);
    expect(DIRECTORY_SNAPSHOT_FIELD_WHITELIST.user).toEqual(DIRECTORY_USER_FIELDS);
    expect(DIRECTORY_SNAPSHOT_FIELD_WHITELIST.group).toEqual(DIRECTORY_GROUP_FIELDS);
  });
});
