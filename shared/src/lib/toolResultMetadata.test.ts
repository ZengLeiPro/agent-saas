import { describe, expect, it } from 'vitest';

import { normalizeToolResultMetadata, toolResultExitCode } from './toolResultMetadata';

describe('normalizeToolResultMetadata', () => {
  it('保留标量字段原值——这正是本通道存在的理由（不再从正文正则回捞）', () => {
    expect(normalizeToolResultMetadata({
      exitCode: 127,
      signal: 'SIGKILL',
      durationMs: 3210,
      stdoutBytes: 12_698,
      timedOut: false,
      outputExceeded: true,
    })).toEqual({
      exitCode: 127,
      signal: 'SIGKILL',
      durationMs: 3210,
      stdoutBytes: 12_698,
      timedOut: false,
      outputExceeded: true,
    });
  });

  it('嵌套对象与数组一律丢弃——那等于又塞进一段需要解析的文本', () => {
    expect(normalizeToolResultMetadata({
      exitCode: 0,
      outputFiles: [{ path: 'a.txt' }],
      nested: { a: 1 },
    })).toEqual({ exitCode: 0 });
  });

  it('NaN / Infinity 不是事实，丢弃', () => {
    expect(normalizeToolResultMetadata({ durationMs: Number.NaN, stdoutBytes: Number.POSITIVE_INFINITY, exitCode: 1 }))
      .toEqual({ exitCode: 1 });
  });

  it('超长字符串值丢弃（signal 之类只可能是短枚举）', () => {
    expect(normalizeToolResultMetadata({ signal: 'x'.repeat(200), exitCode: 0 })).toEqual({ exitCode: 0 });
  });

  it('非对象 / 数组 / 空对象一律返回 null，调用方退回既有判定链', () => {
    expect(normalizeToolResultMetadata(undefined)).toBeNull();
    expect(normalizeToolResultMetadata(null)).toBeNull();
    expect(normalizeToolResultMetadata('exitCode=1')).toBeNull();
    expect(normalizeToolResultMetadata([1, 2])).toBeNull();
    expect(normalizeToolResultMetadata({})).toBeNull();
    expect(normalizeToolResultMetadata({ nested: { a: 1 } })).toBeNull();
  });

  it('键数量与键名长度有上限——脏数据不得撑爆事件', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) many[`k${i}`] = i;
    expect(Object.keys(normalizeToolResultMetadata(many)!).length).toBe(16);
    expect(normalizeToolResultMetadata({ ['k'.repeat(80)]: 1 })).toBeNull();
  });
});

describe('toolResultExitCode', () => {
  it('整数退出码原样返回，包括 0', () => {
    expect(toolResultExitCode({ exitCode: 0 })).toBe(0);
    expect(toolResultExitCode({ exitCode: 137 })).toBe(137);
  });

  it('缺省 / 非整数 / 字符串一律 undefined——「没有退出码」不等于 0', () => {
    expect(toolResultExitCode(undefined)).toBeUndefined();
    expect(toolResultExitCode({})).toBeUndefined();
    expect(toolResultExitCode({ exitCode: 1.5 })).toBeUndefined();
    expect(toolResultExitCode({ exitCode: '1' })).toBeUndefined();
  });
});
