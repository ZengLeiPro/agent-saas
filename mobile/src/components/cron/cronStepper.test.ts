import { describe, expect, it } from 'vitest';
import {
  formatCronMaxTurns,
  formatCronTimeout,
  fromCronStepperValue,
  toCronStepperValue,
} from './cronStepper';

describe('cronStepper 草稿字符串 ⇄ 步进器数值', () => {
  it('空串 / 非法值 / 非正数都映射到 0（留空）', () => {
    expect(toCronStepperValue('')).toBe(0);
    expect(toCronStepperValue('   ')).toBe(0);
    expect(toCronStepperValue('abc')).toBe(0);
    expect(toCronStepperValue('0')).toBe(0);
    expect(toCronStepperValue('-5')).toBe(0);
  });

  it('正整数原样往返', () => {
    expect(toCronStepperValue('8')).toBe(8);
    expect(fromCronStepperValue(8)).toBe('8');
    expect(fromCronStepperValue(toCronStepperValue('1800'))).toBe('1800');
  });

  it('0 档回写成空串，让服务端用默认值', () => {
    expect(fromCronStepperValue(0)).toBe('');
    expect(fromCronStepperValue(-1)).toBe('');
  });

  it('展示文案：0 档统一显示「默认」', () => {
    expect(formatCronMaxTurns(0)).toBe('默认');
    expect(formatCronMaxTurns(5)).toBe('5 轮');
    expect(formatCronTimeout(0)).toBe('默认');
    expect(formatCronTimeout(1800)).toBe('30 分钟');
    expect(formatCronTimeout(300)).toBe('5 分钟');
  });
});
