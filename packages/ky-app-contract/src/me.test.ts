import { describe, expect, it } from 'vitest';

import { validateMe } from './me.js';
import { EXAMPLE_MANIFEST } from './vectors.js';
import type { MeResponse, MenuItem } from './types/me.js';
import type { Manifest } from './types/manifest.js';

const MANIFEST = EXAMPLE_MANIFEST as unknown as Manifest;

function baseMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    contractVersion: 1,
    user: { id: 'u_8f3a', displayName: '张三', roles: ['sales'], isTenantAdmin: true },
    landing: '/orders',
    menus: [
      { key: 'orders', label: '订单', icon: 'package', path: '/orders' },
      {
        key: 'settings',
        label: '设置',
        path: '/settings',
        children: [{ key: 'settings.roles', label: '角色权限', path: '/settings/roles' }],
      },
    ],
    capabilities: [
      { id: 'order.search', enabled: true },
      { id: 'order.create', enabled: false },
    ],
    permVersion: 'pv_1',
    ...overrides,
  };
}

function errorsOf(me: unknown, manifest?: Manifest): string[] {
  return validateMe(me, manifest).errors;
}

describe('validateMe 正例', () => {
  it('合法 me 通过（含 manifest 交叉校验）', () => {
    const result = validateMe(baseMe(), MANIFEST);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('menus 为空且 landing 为 null 通过', () => {
    const result = validateMe(baseMe({ menus: [], landing: null, capabilities: [] }), MANIFEST);
    expect(result.errors).toEqual([]);
  });
});

describe('landing 语义', () => {
  it('menus 非空但 landing 为 null 被拒', () => {
    expect(errorsOf(baseMe({ landing: null })).join('\n')).toMatch(/schema:|不得为 null/u);
  });

  it('landing 指向非叶子被拒', () => {
    expect(errorsOf(baseMe({ landing: '/settings' })).join('\n')).toMatch(
      /不是任何叶子菜单的 path/u,
    );
  });

  it('landing 指向不存在的路径被拒', () => {
    expect(errorsOf(baseMe({ landing: '/nowhere' })).join('\n')).toMatch(
      /不是任何叶子菜单的 path/u,
    );
  });

  it('landing 与叶子 path 只在尾斜杠上不同也接受（共用规范化函数）', () => {
    expect(errorsOf(baseMe({ landing: '/settings/roles/' }))).toEqual([]);
  });

  it('menus 为空但 landing 非 null 被拒', () => {
    expect(errorsOf(baseMe({ menus: [], landing: '/orders' })).length).toBeGreaterThan(0);
  });
});

describe('菜单树语义', () => {
  it('key 全树重复被拒', () => {
    const menus: MenuItem[] = [
      { key: 'orders', label: '订单', path: '/orders' },
      {
        key: 'settings',
        label: '设置',
        path: '/settings',
        children: [{ key: 'orders', label: '角色权限', path: '/settings/roles' }],
      },
    ];
    expect(errorsOf(baseMe({ menus })).join('\n')).toMatch(/key 在全树内重复/u);
  });

  it('深度 4 被拒', () => {
    const menus: MenuItem[] = [
      {
        key: 'l1',
        label: '一',
        path: '/l1',
        children: [
          {
            key: 'l2',
            label: '二',
            path: '/l1/l2',
            children: [
              {
                key: 'l3',
                label: '三',
                path: '/l1/l2/l3',
                children: [{ key: 'l4', label: '四', path: '/l1/l2/l3/l4' }],
              },
            ],
          },
        ],
      },
    ];
    expect(errorsOf(baseMe({ menus, landing: '/l1/l2/l3/l4' })).join('\n')).toMatch(
      /菜单深度 4 超过 3/u,
    );
  });

  it('父节点 children 为空被拒', () => {
    const menus: MenuItem[] = [{ key: 'orders', label: '订单', path: '/orders', children: [] }];
    expect(errorsOf(baseMe({ menus })).join('\n')).toMatch(/父节点必须有 ≥ 1 个可见子节点/u);
  });

  it('path 含 ..、%2F、// 与反斜杠被拒', () => {
    for (const path of ['/a/../b', '/a%2Fb', '/a//b', '/a\\b']) {
      const menus: MenuItem[] = [{ key: 'orders', label: '订单', path }];
      expect(errorsOf(baseMe({ menus, landing: path })).length).toBeGreaterThan(0);
    }
  });
});

describe('capabilities 交叉校验', () => {
  it('id 重复被拒', () => {
    const me = baseMe({
      capabilities: [
        { id: 'order.search', enabled: true },
        { id: 'order.search', enabled: false },
      ],
    });
    expect(errorsOf(me, MANIFEST).join('\n')).toMatch(/order\.search 重复/u);
  });

  it('id 不在 manifest 中被拒', () => {
    const me = baseMe({ capabilities: [{ id: 'order.unknown', enabled: true }] });
    expect(errorsOf(me, MANIFEST).join('\n')).toMatch(/不在 manifest 中/u);
  });

  it('不传 manifest 时不做交叉校验', () => {
    const me = baseMe({ capabilities: [{ id: 'order.unknown', enabled: true }] });
    expect(errorsOf(me)).toEqual([]);
  });
});

describe('schema 层拦截', () => {
  it('contractVersion 不是 1 被拒', () => {
    expect(errorsOf({ ...baseMe(), contractVersion: 2 }).join('\n')).toMatch(/schema:/u);
  });

  it('多余字段被拒', () => {
    expect(errorsOf({ ...baseMe(), extra: 1 }).join('\n')).toMatch(/schema:/u);
  });

  it('menu key 不满足 pattern 被拒', () => {
    const menus = [{ key: 'Orders', label: '订单', path: '/orders' }] as MenuItem[];
    expect(errorsOf(baseMe({ menus })).join('\n')).toMatch(/schema:/u);
  });
});
