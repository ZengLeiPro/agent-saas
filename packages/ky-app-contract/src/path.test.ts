import { describe, expect, it } from 'vitest';

import {
  PathError,
  assertPathPrefix,
  matchPathPrefix,
  normalizeAppPath,
  normalizePathname,
  normalizeToolSegment,
  parseToolName,
  toolName,
} from './path.js';

function expectPathCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PathError);
  expect((caught as PathError).code).toBe(code);
}

describe('normalizeAppPath（§5.2）', () => {
  it('去尾斜杠但保留根路径', () => {
    expect(normalizeAppPath('/orders/')).toBe('/orders');
    expect(normalizeAppPath('/orders')).toBe('/orders');
    expect(normalizeAppPath('/')).toBe('/');
  });

  it('query 键排序并剔除保留参数 ky / ky_iid / ky_nonce', () => {
    expect(normalizeAppPath('/orders?z=1&a=2&ky=1&ky_iid=x&ky_nonce=y')).toBe('/orders?a=2&z=1');
    expect(normalizeAppPath('/orders/?ky=1')).toBe('/orders');
    expect(normalizeAppPath('/orders?b=1&a=2#frag')).toBe('/orders?a=2&b=1#frag');
  });

  it('同名 query 键之间保持原有相对顺序', () => {
    expect(normalizeAppPath('/x?a=2&a=1&b=0')).toBe('/x?a=2&a=1&b=0');
  });

  it('拒 scheme、//、..、%2f/%2e、反斜杠、空白与超长', () => {
    expectPathCode(() => normalizeAppPath('https://evil/x'), 'scheme');
    expectPathCode(() => normalizeAppPath('//evil/x'), 'double_slash');
    expectPathCode(() => normalizeAppPath('/a//b'), 'double_slash');
    expectPathCode(() => normalizeAppPath('/a/../b'), 'dot_segment');
    expectPathCode(() => normalizeAppPath('/a%2Fb'), 'percent_encoded_separator');
    expectPathCode(() => normalizeAppPath('/a%2eb'), 'percent_encoded_separator');
    expectPathCode(() => normalizeAppPath('/a\\b'), 'backslash');
    expectPathCode(() => normalizeAppPath('\\a'), 'backslash');
    expectPathCode(() => normalizeAppPath('orders'), 'not_absolute');
    expectPathCode(() => normalizeAppPath('/a b'), 'whitespace');
    expectPathCode(() => normalizeAppPath(`/${'a'.repeat(600)}`), 'too_long');
    expectPathCode(() => normalizeAppPath(''), 'empty');
  });
});

describe('normalizePathname（§3.3 pfx 匹配前置规范化）', () => {
  it('一次百分号解码后合并 //', () => {
    expect(normalizePathname('/api/app//orders')).toBe('/api/app/orders');
    expect(normalizePathname('/api/app/%E4%B8%AD')).toBe('/api/app/中');
  });

  it('拒解码后仍含 %2f/%2e、反斜杠、.. 段与非法百分号编码', () => {
    expectPathCode(() => normalizePathname('/api/app/%252fadmin'), 'percent_encoded_separator');
    expectPathCode(() => normalizePathname('/api/app/%252Eadmin'), 'percent_encoded_separator');
    expectPathCode(() => normalizePathname('/api/app/%2fadmin'), 'percent_encoded_separator');
    expectPathCode(() => normalizePathname('/api%5Cadmin'), 'backslash');
    expectPathCode(() => normalizePathname('/api/app/../admin'), 'dot_segment');
    expectPathCode(() => normalizePathname('/api/app/%2e%2e/admin'), 'percent_encoded_separator');
    expectPathCode(() => normalizePathname('/api/%zz'), 'percent_encoded_separator');
    expectPathCode(() => normalizePathname('api/app'), 'not_absolute');
  });

  it('合并 // 后仍存在的 .. 段照样拒绝（§9.3-3 的 // 用例）', () => {
    expectPathCode(() => normalizePathname('/api/app//../admin/x'), 'dot_segment');
  });
});

describe('matchPathPrefix', () => {
  const prefixes = ['/api/app/'];

  it('完整 segment 前缀匹配', () => {
    expect(matchPathPrefix('/api/app/orders', prefixes)).toBe(true);
    expect(matchPathPrefix('/api/app/', prefixes)).toBe(true);
  });

  it('/api/apps 不匹配 /api/app/', () => {
    expect(matchPathPrefix('/api/apps', prefixes)).toBe(false);
    expect(matchPathPrefix('/api/apps/orders', prefixes)).toBe(false);
    expect(matchPathPrefix('/api/app', prefixes)).toBe(false);
  });

  it('非法 pathname 一律 false，不抛错', () => {
    expect(matchPathPrefix('/api/app/%2fadmin', prefixes)).toBe(false);
    expect(matchPathPrefix('/api/app/../admin', prefixes)).toBe(false);
    expect(matchPathPrefix('/api/app\\admin', prefixes)).toBe(false);
  });

  it('前缀本身不合法时不匹配', () => {
    expect(matchPathPrefix('/api/app/orders', ['/api/app'])).toBe(false);
    expect(matchPathPrefix('/anything', ['/'])).toBe(false);
    expectPathCode(() => assertPathPrefix('/api/app'), 'not_a_prefix');
    expect(() => assertPathPrefix('/api/app/')).not.toThrow();
  });
});

describe('parseToolName（§4.5 逆向拆解）', () => {
  it('拆回规范化后的分段，round-trip 与 toolName 一致', () => {
    expect(parseToolName(toolName('demo-erp', 'order.search'))).toEqual({
      systemSegment: 'demo_erp',
      capabilitySegment: 'order_search',
    });
  });

  it('能力段含双下划线时原样拼回', () => {
    expect(parseToolName('app__erp__order__search')).toEqual({
      systemSegment: 'erp',
      capabilitySegment: 'order__search',
    });
  });

  it('非 app__ 前缀或缺段一律返回 null', () => {
    expect(parseToolName('mcp__github__search')).toBeNull();
    expect(parseToolName('Read')).toBeNull();
    expect(parseToolName('app__erp')).toBeNull();
    expect(parseToolName('app__')).toBeNull();
    expect(parseToolName('app____cap')).toBeNull();
  });
});

describe('toolName（§4.5）', () => {
  it('规范化 - 与 . 为 _', () => {
    expect(normalizeToolSegment('order.search')).toBe('order_search');
    expect(toolName('demo-erp', 'order.search')).toBe('app__demo_erp__order_search');
    expect(toolName('demo-erp', 'order.create')).toBe('app__demo_erp__order_create');
  });

  it('超过 64 字符拒绝', () => {
    // systemId 24 + capabilityId 32 + 前缀与分隔符 7 = 63，再多一位就超限。
    const systemId = `s${'a'.repeat(23)}`;
    const capabilityId = `c${'b'.repeat(31)}`;
    expect(toolName(systemId, capabilityId)).toHaveLength(63);
    expectPathCode(() => toolName(systemId, `${capabilityId}xx`), 'tool_name_too_long');
  });
});
