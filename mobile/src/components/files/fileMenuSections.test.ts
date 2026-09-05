import { describe, expect, it } from 'vitest';
import {
  FILE_MENU_IDS,
  buildFileMenuSections,
  nextSortState,
  parseFileMenuAction,
} from './fileMenuSections';
import { sortFileEntries } from '../../lib/fileSort';

const base = { sortKey: 'modifiedAt', sortOrder: 'desc', layoutMode: 'list' } as const;

describe('buildFileMenuSections', () => {
  it('普通用户只有布局/排序/刷新三组', () => {
    const sections = buildFileMenuSections({ ...base });
    expect(sections.map((s) => s.id)).toEqual([
      '_layout_section',
      '_sort_section',
      '_actions_section',
    ]);
  });

  it('布局与排序的选中态可回读', () => {
    const [layout, sort] = buildFileMenuSections({ ...base, layoutMode: 'grid' });
    expect(layout.actions.find((a) => a.id === FILE_MENU_IDS.layoutGrid)?.checked).toBe(true);
    expect(layout.actions.find((a) => a.id === FILE_MENU_IDS.layoutList)?.checked).toBe(false);
    expect(sort.label).toBe('排序 (降序)');
    expect(sort.actions.find((a) => a.id === 'modifiedAt')?.label).toContain('↓');
  });

  it('管理员在列表页才有根目录入口与 owner 过滤', () => {
    const withRoot = buildFileMenuSections({
      ...base,
      isAdmin: true,
      includeRootEntry: true,
      users: [{ username: 'alice', realName: '爱丽丝' }, { username: 'bob' }],
      ownerFilter: 'bob',
    });
    expect(withRoot.map((s) => s.id)).toContain('_nav_section');
    const owners = withRoot.find((s) => s.id === '_owner_section');
    expect(owners?.actions.map((a) => a.label)).toEqual(['爱丽丝', 'bob']);
    expect(owners?.actions.find((a) => a.id === '_owner:bob')?.checked).toBe(true);

    const inFolder = buildFileMenuSections({ ...base, isAdmin: true, includeRootEntry: false });
    expect(inFolder.map((s) => s.id)).not.toContain('_nav_section');
  });

  it('非管理员即使传了用户列表也不露出 owner 过滤', () => {
    const sections = buildFileMenuSections({ ...base, users: [{ username: 'alice' }] });
    expect(sections.map((s) => s.id)).not.toContain('_owner_section');
  });
});

describe('parseFileMenuAction', () => {
  it('识别全部动作类型', () => {
    expect(parseFileMenuAction('_layout:grid')).toEqual({ type: 'layout', mode: 'grid' });
    expect(parseFileMenuAction('_layout:list')).toEqual({ type: 'layout', mode: 'list' });
    expect(parseFileMenuAction('_refresh')).toEqual({ type: 'refresh' });
    expect(parseFileMenuAction('_root')).toEqual({ type: 'root' });
    expect(parseFileMenuAction('_owner:alice')).toEqual({ type: 'owner', username: 'alice' });
    expect(parseFileMenuAction('size')).toEqual({ type: 'sort', key: 'size' });
  });

  it('未知动作与空 owner 返回 null（不误当排序键处理）', () => {
    expect(parseFileMenuAction('_owner:')).toBeNull();
    expect(parseFileMenuAction('whatever')).toBeNull();
  });
});

describe('nextSortState', () => {
  it('同列翻转方向', () => {
    expect(nextSortState({ key: 'name', order: 'asc' }, 'name')).toEqual({
      key: 'name',
      order: 'desc',
    });
  });

  it('换列用该列默认方向', () => {
    expect(nextSortState({ key: 'name', order: 'asc' }, 'modifiedAt')).toEqual({
      key: 'modifiedAt',
      order: 'desc',
    });
    expect(nextSortState({ key: 'modifiedAt', order: 'desc' }, 'size')).toEqual({
      key: 'size',
      order: 'asc',
    });
  });
});

describe('sortFileEntries', () => {
  const entries = [
    { name: 'b.md', isDirectory: false, modifiedAt: 3, size: 10, extension: '.md' },
    { name: 'docs', isDirectory: true, modifiedAt: 1, size: 0, extension: '' },
    { name: 'a.md', isDirectory: false, modifiedAt: 2, size: 30, extension: '.md' },
  ];

  it('目录恒在前，与 Web 一致', () => {
    for (const order of ['asc', 'desc'] as const) {
      expect(sortFileEntries(entries, 'name', order)[0].name).toBe('docs');
    }
  });

  it('按列排序且方向生效', () => {
    expect(sortFileEntries(entries, 'name', 'asc').map((e) => e.name)).toEqual([
      'docs',
      'a.md',
      'b.md',
    ]);
    expect(sortFileEntries(entries, 'size', 'desc').map((e) => e.name)).toEqual([
      'docs',
      'a.md',
      'b.md',
    ]);
    expect(sortFileEntries(entries, 'modifiedAt', 'desc').map((e) => e.name)).toEqual([
      'docs',
      'b.md',
      'a.md',
    ]);
  });

  it('不修改入参数组', () => {
    const input = [...entries];
    sortFileEntries(input, 'name', 'asc');
    expect(input.map((e) => e.name)).toEqual(['b.md', 'docs', 'a.md']);
  });
});
