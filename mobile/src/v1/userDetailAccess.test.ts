import { describe, expect, it } from 'vitest';
import type { UserInfo } from '@agent/shared';
import { selectUserDetailProfile } from './userDetailAccess';

function user(id: string): UserInfo {
  return { id, username: id, role: 'user', tenantId: 'tenant-1' } as UserInfo;
}

describe('M30-01 production user-detail identity isolation', () => {
  it('does not expose administrator A from an old list after logout and login as B', () => {
    const administratorA = user('admin-a');
    expect(selectUserDetailProfile({
      profile: 'production',
      currentUserId: 'user-b',
      requestedUserId: 'admin-a',
      selfProfile: user('user-b'),
      users: [administratorA],
    })).toBeNull();
  });

  it('allows the current production user only from the self endpoint response', () => {
    const current = user('user-b');
    expect(selectUserDetailProfile({
      profile: 'production',
      currentUserId: current.id,
      requestedUserId: current.id,
      selfProfile: current,
      users: [user('stale-b')],
    })).toBe(current);
  });

  it('keeps preview administrator lookup available outside production', () => {
    const target = user('managed-user');
    expect(selectUserDetailProfile({
      profile: 'preview',
      currentUserId: 'admin-a',
      requestedUserId: target.id,
      selfProfile: null,
      users: [target],
    })).toBe(target);
  });
});
