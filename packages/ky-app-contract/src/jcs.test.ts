import { describe, expect, it } from 'vitest';

import { JcsError, canonicalize, canonicalizeText, hasLoneSurrogate, parseIJson } from './jcs.js';
import { APH_VECTORS, REJECT_VECTORS } from './vectors.js';

function expectJcsCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(JcsError);
  expect((caught as JcsError).code).toBe(code);
}

describe('canonicalize（RFC 8785）', () => {
  it('-0 规范化为 0，1.0 规范化为 1', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize({ z: -0 })).toBe('{"z":0}');
    expect(canonicalize(1.0)).toBe('1');
    expect(canonicalizeText('{"a":1.0,"b":-0}')).toBe('{"a":1,"b":0}');
  });

  it('嵌套对象逐层按键排序，数组顺序保持原样', () => {
    const value = { b: { d: 1, c: { f: 2, e: 3 } }, a: [3, 1, 2] };
    expect(canonicalize(value)).toBe('{"a":[3,1,2],"b":{"c":{"e":3,"f":2},"d":1}}');
  });

  it('键按 UTF-16 code unit 排序：BMP 外字符排在 U+FFFD 之前', () => {
    // U+1F600 = D83D DE00：按 code point 排在 U+FFFD 之后，按 UTF-16 code unit 排在之前。
    const emoji = '\u{1F600}';
    const replacement = '�';
    const value: Record<string, number> = {};
    value[replacement] = 1;
    value[emoji] = 2;
    value.a = 3;
    const output = canonicalize(value);
    expect(output.indexOf(emoji)).toBeLessThan(output.indexOf(replacement));
    expect(output.indexOf('"a"')).toBeLessThan(output.indexOf(emoji));
  });

  it('字符串转义与 JSON.stringify 一致', () => {
    const value = { s: 'a"b\\c\nd\tef' };
    expect(canonicalize(value)).toBe(JSON.stringify(value));
    expect(canonicalize({ s: '\u{1F600}' })).toBe('{"s":"\u{1F600}"}');
  });

  it('拒绝非有限数、非安全整数、孤立代理项、undefined 与非普通对象', () => {
    expectJcsCode(() => canonicalize({ n: Number.POSITIVE_INFINITY }), 'non_finite_number');
    expectJcsCode(() => canonicalize({ n: Number.NaN }), 'non_finite_number');
    expectJcsCode(() => canonicalize({ n: 9007199254740993 }), 'unsafe_integer');
    expectJcsCode(() => canonicalize({ s: '\uD800' }), 'lone_surrogate');
    expectJcsCode(() => canonicalize({ s: '\uDC00x' }), 'lone_surrogate');
    expectJcsCode(() => canonicalize({ a: undefined }), 'unsupported_type');
    expectJcsCode(() => canonicalize({ d: new Date(0) }), 'unsupported_type');
    expectJcsCode(() => canonicalize({ m: new Map() }), 'unsupported_type');
  });

  it('接受配对的代理项', () => {
    expect(hasLoneSurrogate('\u{1F600}')).toBe(false);
    expect(hasLoneSurrogate('\uD83D')).toBe(true);
  });
});

describe('parseIJson（I-JSON 严格解析）', () => {
  it('解析基本值并保留 -0', () => {
    expect(parseIJson('{"a":[1,true,null,"x"]}')).toEqual({ a: [1, true, null, 'x'] });
    expect(Object.is((parseIJson('{"z":-0}') as { z: number }).z, -0)).toBe(true);
    expect(parseIJson('{}')).toEqual({});
    expect(parseIJson('[]')).toEqual([]);
  });

  it('附录 I 的三个拒绝向量各自抛对应错误', () => {
    expect(REJECT_VECTORS).toHaveLength(3);
    for (const vector of REJECT_VECTORS) {
      expectJcsCode(() => parseIJson(vector.json), vector.code);
    }
  });

  it('拒绝 1e999、尾部多余内容、未转义控制字符与非法转义', () => {
    expectJcsCode(() => parseIJson('{"n":1e999}'), 'non_finite_number');
    expectJcsCode(() => parseIJson('{"a":1} trailing'), 'invalid_json');
    expectJcsCode(() => parseIJson('{"a":"\n"}'), 'invalid_json');
    expectJcsCode(() => parseIJson('{"a":"\\x"}'), 'invalid_json');
    expectJcsCode(() => parseIJson('{"a":01}'), 'invalid_json');
    expectJcsCode(() => parseIJson(''), 'invalid_json');
  });

  it('嵌套对象里的重复键同样拒绝', () => {
    expectJcsCode(() => parseIJson('{"a":{"b":1,"b":2}}'), 'duplicate_key');
  });

  it('__proto__ 作为普通键不会污染原型', () => {
    const parsed = parseIJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('附录 I 向量的 canonical 形式', () => {
  for (const vector of APH_VECTORS) {
    if (vector.canonical === undefined) continue;
    it(`${vector.name} 的 canonical 形式一致`, () => {
      expect(canonicalizeText(vector.json)).toBe(vector.canonical);
    });
  }
});
