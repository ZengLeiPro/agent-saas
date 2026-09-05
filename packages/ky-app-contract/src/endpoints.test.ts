import { describe, expect, it } from 'vitest';

import { isEndpointAllowed } from './claims.js';
import type { EndpointAuthorizationOptions } from './claims.js';
import type { EndpointActor } from './types/claims.js';

const PREFIXES = { user: ['/api/app/'], admin: ['/api/admin/'] };
const ACTORS: readonly EndpointActor[] = [
  'public',
  'user',
  'agent',
  'platform',
  'local_admin',
  'local_user',
];

function allow(
  actor: EndpointActor,
  method: string,
  pathname: string,
  overrides: Partial<EndpointAuthorizationOptions> = {},
): boolean {
  return isEndpointAllowed(actor, method, pathname, { pathPrefixes: PREFIXES, ...overrides });
}

describe('§3.3 公开行', () => {
  it('health/live 与 attest 对所有主体开放', () => {
    for (const actor of ACTORS) {
      expect(allow(actor, 'GET', '/ky/v1/health/live')).toBe(true);
      expect(allow(actor, 'GET', '/ky/v1/attest')).toBe(true);
    }
  });

  it('POST /ky-local/enable 始终公开，即使兜底模式关闭', () => {
    expect(allow('public', 'POST', '/ky-local/enable')).toBe(true);
    expect(allow('public', 'POST', '/ky-local/enable', { localMode: false })).toBe(true);
  });

  it('/ky-local/* 其余在兜底开启时公开，关闭时不可达', () => {
    expect(allow('public', 'POST', '/ky-local/login', { localMode: true })).toBe(true);
    expect(allow('public', 'POST', '/ky-local/login')).toBe(false);
    expect(allow('local_admin', 'POST', '/ky-local/login')).toBe(false);
  });

  it('/ky/v1/test/* 只在 test 环境开放', () => {
    expect(allow('public', 'POST', '/ky/v1/test/provision', { testEndpoints: true })).toBe(true);
    expect(allow('public', 'POST', '/ky/v1/test/provision')).toBe(false);
    expect(allow('platform', 'POST', '/ky/v1/test/provision')).toBe(false);
  });

  it('方法不符即不在表内', () => {
    expect(allow('public', 'POST', '/ky/v1/health/live')).toBe(false);
    expect(allow('public', 'POST', '/ky/v1/attest')).toBe(false);
    expect(allow('public', 'GET', '/ky-local/enable')).toBe(false);
  });
});

describe('§3.3 platform 行', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/ky/v1/health/ready'],
    ['GET', '/ky/v1/manifest'],
    ['POST', '/ky/v1/events'],
  ];

  it('只有 platform 可达', () => {
    for (const [method, path] of endpoints) {
      for (const actor of ACTORS) {
        expect(allow(actor, method, path), `${actor} ${method} ${path}`).toBe(actor === 'platform');
      }
    }
  });
});

describe('§3.3 agent 行', () => {
  it('只有 agent 可调能力与执行查询', () => {
    for (const actor of ACTORS) {
      expect(allow(actor, 'POST', '/ky/v1/capabilities/order.create')).toBe(actor === 'agent');
      expect(allow(actor, 'GET', '/ky/v1/capabilities/order.create/executions/lc_9c2')).toBe(
        actor === 'agent',
      );
    }
  });

  it('方法与形状不符一律拒', () => {
    expect(allow('agent', 'GET', '/ky/v1/capabilities/order.create')).toBe(false);
    expect(allow('agent', 'POST', '/ky/v1/capabilities/order.create/executions/lc_9c2')).toBe(
      false,
    );
    expect(allow('agent', 'POST', '/ky/v1/capabilities')).toBe(false);
    expect(allow('agent', 'POST', '/ky/v1/capabilities/a/b')).toBe(false);
    expect(allow('agent', 'GET', '/ky/v1/me')).toBe(false);
  });
});

describe('§3.3 /ky/v1/me 行', () => {
  it('user / local_admin / local_user 可达，其余不可达', () => {
    for (const actor of ACTORS) {
      const expected = actor === 'user' || actor === 'local_admin' || actor === 'local_user';
      expect(allow(actor, 'GET', '/ky/v1/me'), actor).toBe(expected);
    }
  });
});

describe('§3.3 pathPrefixes 行', () => {
  it('user 前缀：user / local_admin / local_user 可达', () => {
    for (const actor of ACTORS) {
      const expected = actor === 'user' || actor === 'local_admin' || actor === 'local_user';
      expect(allow(actor, 'GET', '/api/app/orders'), actor).toBe(expected);
      expect(allow(actor, 'POST', '/api/app/orders'), actor).toBe(expected);
    }
  });

  it('admin 前缀：user 仅 tadm，local_admin 可达，local_user 不可达', () => {
    expect(allow('user', 'GET', '/api/admin/roles', { tadm: true })).toBe(true);
    expect(allow('user', 'GET', '/api/admin/roles', { tadm: false })).toBe(false);
    expect(allow('user', 'GET', '/api/admin/roles')).toBe(false);
    expect(allow('local_admin', 'GET', '/api/admin/roles')).toBe(true);
    expect(allow('local_user', 'GET', '/api/admin/roles')).toBe(false);
    expect(allow('agent', 'GET', '/api/admin/roles')).toBe(false);
    expect(allow('platform', 'GET', '/api/admin/roles')).toBe(false);
    expect(allow('public', 'GET', '/api/admin/roles')).toBe(false);
  });

  it('/api/apps 不匹配 /api/app/', () => {
    expect(allow('user', 'GET', '/api/apps')).toBe(false);
    expect(allow('user', 'GET', '/api/apps/orders')).toBe(false);
    expect(allow('user', 'GET', '/api/app')).toBe(false);
  });

  it('%2f、..、//+..、反斜杠一律拒', () => {
    expect(allow('user', 'GET', '/api/app/%2fadmin', { tadm: true })).toBe(false);
    expect(allow('user', 'GET', '/api/app/../admin/roles', { tadm: true })).toBe(false);
    expect(allow('user', 'GET', '/api/app//../admin/roles', { tadm: true })).toBe(false);
    expect(allow('user', 'GET', '/api/app\\admin', { tadm: true })).toBe(false);
    expect(allow('user', 'GET', '/api%2fapp/orders')).toBe(false);
    expect(allow('user', 'GET', '/api/app/%252fadmin')).toBe(false);
  });

  it('合并 // 后仍在 user 前缀内的请求放行', () => {
    expect(allow('user', 'GET', '/api/app//orders')).toBe(true);
  });

  it('保留前缀永不走 pathPrefixes 匹配', () => {
    const rogue = { user: ['/ky/', '/internal/', '/ky-local/'], admin: ['/api/admin/'] };
    expect(allow('user', 'GET', '/ky/v1/manifest', { pathPrefixes: rogue })).toBe(false);
    expect(allow('user', 'GET', '/internal/debug', { pathPrefixes: rogue })).toBe(false);
    expect(allow('local_admin', 'GET', '/internal/debug', { pathPrefixes: rogue })).toBe(false);
  });
});

describe('表外一律不放行', () => {
  it('未知路径与未知主体都返回 false', () => {
    for (const actor of ACTORS) {
      expect(allow(actor, 'GET', '/ky/v1/unknown'), actor).toBe(false);
      expect(allow(actor, 'GET', '/nothing/here'), actor).toBe(false);
    }
    expect(
      isEndpointAllowed('nobody' as EndpointActor, 'GET', '/api/app/orders', {
        pathPrefixes: PREFIXES,
      }),
    ).toBe(false);
  });
});
