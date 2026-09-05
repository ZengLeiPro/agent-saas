import { describe, expect, it } from 'vitest';
import {
  SANDBOX_PROFILE_OPTIONS,
  isSandboxProfileLocked,
  resolveSessionSandboxProfile,
  sandboxProfileLabel,
} from './sandboxProfile';

describe('sandboxProfile', () => {
  it('选项顺序与标签与 Web ChatInput 一致', () => {
    expect(SANDBOX_PROFILE_OPTIONS.map((option) => option.value)).toEqual(['daily', 'coding']);
    expect(SANDBOX_PROFILE_OPTIONS.map((option) => option.label)).toEqual(['日常', '编程']);
  });

  it('只有 coding 显示「编程」，其余（含空值）显示「日常」', () => {
    expect(sandboxProfileLabel('coding')).toBe('编程');
    expect(sandboxProfileLabel('daily')).toBe('日常');
    expect(sandboxProfileLabel(null)).toBe('日常');
    expect(sandboxProfileLabel(undefined)).toBe('日常');
  });

  it('会话详情归一化：只有显式 daily 是日常，其余按 coding 兜底', () => {
    expect(resolveSessionSandboxProfile('daily')).toBe('daily');
    expect(resolveSessionSandboxProfile('coding')).toBe('coding');
    expect(resolveSessionSandboxProfile(undefined)).toBe('coding');
    expect(resolveSessionSandboxProfile(42)).toBe('coding');
  });

  it('会话已存在、加载中或只读时锁定档位', () => {
    expect(isSandboxProfileLocked({})).toBe(false);
    expect(isSandboxProfileLocked({ sessionId: null, loading: false, disabled: false })).toBe(
      false,
    );
    expect(isSandboxProfileLocked({ sessionId: 's-1' })).toBe(true);
    expect(isSandboxProfileLocked({ loading: true })).toBe(true);
    expect(isSandboxProfileLocked({ disabled: true })).toBe(true);
  });
});
