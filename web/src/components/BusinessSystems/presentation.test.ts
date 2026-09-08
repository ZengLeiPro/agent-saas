import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessStatusLabel, formatBusinessSystemTime, shortDigest } from './presentation';

describe('业务系统展示转换', () => {
  afterEach(() => vi.restoreAllMocks());

  it('技术状态统一转换为中文，未知值不原样显示', () => {
    expect(businessStatusLabel('waiting_external')).toBe('等待外部处理');
    expect(businessStatusLabel('ready_required')).toBe('等待业务服务就绪');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(businessStatusLabel('new_backend_state')).toBe('未知状态');
    expect(warning).toHaveBeenCalled();
  });

  it('ISO 时间使用中文本地格式，空值和非法值有安全文案', () => {
    expect(formatBusinessSystemTime(null)).toBe('暂无');
    expect(formatBusinessSystemTime('bad-date')).toBe('时间未知');
    expect(formatBusinessSystemTime('2026-09-08T07:10:00.187Z')).toMatch(/2026年9月8日/);
  });

  it('默认只展示短摘要', () => {
    expect(shortDigest('a'.repeat(64))).toBe('a'.repeat(10));
  });
});
