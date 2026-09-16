import { describe, expect, it } from 'vitest';
import { buildGroupPushHref, resolveGroupListNavigation } from './groupListNavigation';

describe('groupListNavigation', () => {
  it('builds a stack href with encoded key and name', () => {
    expect(buildGroupPushHref('g1', '工作')).toBe('/(tabs)/chat/group/g1?name=%E5%B7%A5%E4%BD%9C');
    expect(buildGroupPushHref('a/b', 'x y')).toBe('/(tabs)/chat/group/a%2Fb?name=x%20y');
  });

  it('keeps md+ in-pane (no stack push)', () => {
    expect(resolveGroupListNavigation({ isMdUp: true, groupKey: 'g1', name: '工作' })).toEqual({
      kind: 'pane',
      groupKey: 'g1',
      name: '工作',
    });
  });

  it('stack-pushes on phone (< md)', () => {
    expect(resolveGroupListNavigation({ isMdUp: false, groupKey: 'g1', name: '工作' })).toEqual({
      kind: 'push',
      href: '/(tabs)/chat/group/g1?name=%E5%B7%A5%E4%BD%9C',
      groupKey: 'g1',
      name: '工作',
    });
  });
});
