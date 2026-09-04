/**
 * 分组行的首尾圆角 / 分隔线规则测试。
 * 这是「一组设置项看起来像一张卡」的唯一依据，错一个位置整组视觉就会破。
 */
import { describe, expect, it } from 'vitest';
import { radius } from '../../theme/spacing';
import { resolveListRowPosition, resolveListRowShape } from './listRowStyles';

describe('resolveListRowPosition', () => {
  it('单行分组是 only', () => {
    expect(resolveListRowPosition(0, 1)).toBe('only');
    expect(resolveListRowPosition(0, 0)).toBe('only');
  });

  it('多行分组按序号给出 first / middle / last', () => {
    expect(resolveListRowPosition(0, 3)).toBe('first');
    expect(resolveListRowPosition(1, 3)).toBe('middle');
    expect(resolveListRowPosition(2, 3)).toBe('last');
  });

  it('越界序号收敛到首尾而不是抛错', () => {
    expect(resolveListRowPosition(-1, 3)).toBe('first');
    expect(resolveListRowPosition(9, 3)).toBe('last');
  });
});

describe('resolveListRowShape', () => {
  it('only 四角全圆并且不画分隔线', () => {
    const shape = resolveListRowShape('only');
    expect(shape.borderTopLeftRadius).toBe(radius.lg);
    expect(shape.borderBottomRightRadius).toBe(radius.lg);
    expect(shape.showSeparator).toBe(false);
  });

  it('first 只圆上两角并带分隔线', () => {
    const shape = resolveListRowShape('first');
    expect(shape.borderTopLeftRadius).toBe(radius.lg);
    expect(shape.borderTopRightRadius).toBe(radius.lg);
    expect(shape.borderBottomLeftRadius).toBe(0);
    expect(shape.borderBottomRightRadius).toBe(0);
    expect(shape.showSeparator).toBe(true);
  });

  it('middle 四角全直角并带分隔线', () => {
    const shape = resolveListRowShape('middle');
    expect(shape.borderTopLeftRadius).toBe(0);
    expect(shape.borderBottomLeftRadius).toBe(0);
    expect(shape.showSeparator).toBe(true);
  });

  it('last 只圆下两角，且不再画分隔线（否则会和卡片下边缘重影）', () => {
    const shape = resolveListRowShape('last');
    expect(shape.borderTopLeftRadius).toBe(0);
    expect(shape.borderBottomLeftRadius).toBe(radius.lg);
    expect(shape.borderBottomRightRadius).toBe(radius.lg);
    expect(shape.showSeparator).toBe(false);
  });

  it('圆角半径可覆盖（分组卡需要更圆时用 radius.xl）', () => {
    const shape = resolveListRowShape('first', radius.xl);
    expect(shape.borderTopLeftRadius).toBe(radius.xl);
  });
});
