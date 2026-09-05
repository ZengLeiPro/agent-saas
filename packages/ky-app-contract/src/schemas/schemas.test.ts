import { describe, expect, it } from 'vitest';

import {
  SCHEMAS,
  SCHEMA_IDS,
  validateConformance,
  validateDirectoryChanges,
  validateDirectoryEvent,
  validateDirectoryGone,
  validateDirectorySnapshot,
  validateManifestSchema,
  validateMeSchema,
} from './index.js';
import type { DirectoryChanges, DirectorySnapshot } from '../types/directory.js';
import type { ConformanceFixture } from '../types/manifest.js';

describe('五份 schema 都注册且带 $id', () => {
  it('SCHEMAS 按 $id 索引', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(Object.values(SCHEMA_IDS).sort());
    for (const [id, schema] of Object.entries(SCHEMAS)) {
      expect(schema.$id, id).toBe(id);
    }
  });

  it('manifest 与 me 的编译入口可用', () => {
    expect(validateManifestSchema({}).ok).toBe(false);
    expect(validateMeSchema({}).ok).toBe(false);
  });
});

describe('附录 L 目录 schema', () => {
  const snapshot: DirectorySnapshot = {
    snapshotSeq: 12,
    pageToken: 'opaque',
    users: [
      {
        userId: 'u_1',
        displayName: '张三',
        employeeNo: 'E001',
        status: 'active',
        isTenantAdmin: true,
        groupIds: ['g_1'],
      },
    ],
    groups: [{ groupId: 'g_1', displayName: '销售部', parentGroupId: null, status: 'active' }],
  };

  it('合法快照通过', () => {
    expect(validateDirectorySnapshot(snapshot).errors).toEqual([]);
  });

  it('缺 snapshotSeq、多余字段、status 越界均被拒', () => {
    const { snapshotSeq: _omit, ...withoutSeq } = snapshot;
    expect(validateDirectorySnapshot(withoutSeq).ok).toBe(false);
    expect(validateDirectorySnapshot({ ...snapshot, extra: 1 }).ok).toBe(false);
    expect(
      validateDirectorySnapshot({
        ...snapshot,
        users: [{ ...snapshot.users[0]!, status: 'removed' }],
      }).ok,
    ).toBe(false);
  });

  it('四种事件各自通过，type 与载荷不匹配被拒', () => {
    const events = [
      { seq: 1, eventId: 'e1', type: 'user.upsert', user: snapshot.users[0]! },
      { seq: 2, eventId: 'e2', type: 'user.remove', userId: 'u_1' },
      { seq: 3, eventId: 'e3', type: 'group.upsert', group: snapshot.groups[0]! },
      { seq: 4, eventId: 'e4', type: 'group.remove', groupId: 'g_1' },
    ];
    for (const event of events)
      expect(validateDirectoryEvent(event).errors, event.type).toEqual([]);
    expect(validateDirectoryEvent({ seq: 1, eventId: 'e1', type: 'user.upsert' }).ok).toBe(false);
    expect(
      validateDirectoryEvent({ seq: 1, eventId: 'e1', type: 'user.remove', group: {} }).ok,
    ).toBe(false);
    expect(
      validateDirectoryEvent({ seq: 0, eventId: 'e', type: 'user.remove', userId: 'u' }).ok,
    ).toBe(false);
  });

  it('变更流与 410 响应', () => {
    const changes: DirectoryChanges = {
      events: [{ seq: 1, eventId: 'e1', type: 'user.remove', userId: 'u_1' }],
      nextSeq: 2,
      hasMore: false,
    };
    expect(validateDirectoryChanges(changes).errors).toEqual([]);
    expect(validateDirectoryChanges({ ...changes, nextSeq: -1 }).ok).toBe(false);
    expect(validateDirectoryGone({ code: 'snapshot_expired' }).errors).toEqual([]);
    expect(validateDirectoryGone({ code: 'cursor_expired', requestId: 'r' }).errors).toEqual([]);
    expect(validateDirectoryGone({ code: 'gone' }).ok).toBe(false);
  });
});

describe('附录 J 一致性夹具 schema', () => {
  const fixture: ConformanceFixture = {
    contractVersion: 1,
    users: {
      admin: { sub: 'test-admin', tadm: true },
      member: { sub: 'test-member', roles: ['sales'] },
      norole: { sub: 'test-norole' },
    },
    capabilities: {
      'order.search': {
        validInputs: [{ input: { keyword: 'x' }, expect: { hasMore: false } }],
        invalidInputs: [{ input: {}, expectCode: 'invalid_input' }],
        cleanup: { capabilityId: 'order.cancel', input: {} },
        pageApiEquivalence: {
          method: 'GET',
          path: '/api/app/orders',
          query: {},
          idField: 'id',
          capabilityInput: { keyword: 'x' },
        },
      },
    },
    endpoints: ['/', '/index.html', '/ky/v1/health/live', '/api/app/orders'],
  };

  it('附录 J 示例通过', () => {
    expect(validateConformance(fixture).errors).toEqual([]);
  });

  it('缺三个测试用户之一、非法能力 id、未知错误码均被拒', () => {
    const { norole: _omit, ...users } = fixture.users;
    expect(validateConformance({ ...fixture, users }).ok).toBe(false);
    expect(
      validateConformance({
        ...fixture,
        capabilities: { 'Order.Search': { validInputs: [{ input: {} }] } },
      }).ok,
    ).toBe(false);
    expect(
      validateConformance({
        ...fixture,
        capabilities: {
          'order.search': {
            validInputs: [{ input: {} }],
            invalidInputs: [{ input: {}, expectCode: 'nope' }],
          },
        },
      }).ok,
    ).toBe(false);
    expect(validateConformance({ ...fixture, contractVersion: 2 }).ok).toBe(false);
  });
});
