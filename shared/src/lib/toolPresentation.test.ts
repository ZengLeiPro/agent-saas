import { describe, expect, it } from 'vitest';
import { normalizeToolPresentation } from './toolPresentation';

describe('normalizeToolPresentation', () => {
  it('title 缺失或非字符串一律返回 null（渲染层回退原始 payload）', () => {
    expect(normalizeToolPresentation(null)).toBeNull();
    expect(normalizeToolPresentation('not an object')).toBeNull();
    expect(normalizeToolPresentation({})).toBeNull();
    expect(normalizeToolPresentation({ title: '   ' })).toBeNull();
    expect(normalizeToolPresentation({ title: 123 })).toBeNull();
  });

  it('保留 5 种 detail 变体', () => {
    const result = normalizeToolPresentation({
      title: '核对选型表',
      detail: [
        '纯文本行',
        { k: '匹配型号', v: 'WDU 2.5' },
        { tree: '└', k: '库存', v: '1,240 件' },
        { no: 2, text: '写入台账' },
        { indent: 2, text: '⚠ 库存低于安全线' },
      ],
    });
    expect(result?.detail).toEqual([
      '纯文本行',
      { k: '匹配型号', v: 'WDU 2.5' },
      { tree: '└', k: '库存', v: '1,240 件' },
      { no: 2, text: '写入台账' },
      { indent: 2, text: '⚠ 库存低于安全线' },
    ]);
  });

  it('丢弃无法识别的 detail 行，但不整体失败', () => {
    const result = normalizeToolPresentation({
      title: 'x',
      detail: [{ k: '保留', v: 'v' }, { nope: 1 }, null, 42, { k: '  ' }],
    });
    expect(result?.detail).toEqual([{ k: '保留', v: 'v' }]);
  });

  it('detail 为空数组或全部非法时不产出 detail 字段', () => {
    expect(normalizeToolPresentation({ title: 'x', detail: [] })?.detail).toBeUndefined();
    expect(normalizeToolPresentation({ title: 'x', detail: [{ bad: 1 }] })?.detail).toBeUndefined();
  });

  it('k 存在但 v 缺失时补空串，不丢整行', () => {
    expect(normalizeToolPresentation({ title: 'x', detail: [{ k: '仅键' }] })?.detail)
      .toEqual([{ k: '仅键', v: '' }]);
  });

  it('indent 夹逼到 0~6，no 取整', () => {
    const result = normalizeToolPresentation({
      title: 'x',
      detail: [{ indent: 99, text: 'a' }, { indent: -3, text: 'b' }, { no: 3.7, text: 'c' }],
    });
    expect(result?.detail).toEqual([
      { indent: 6, text: 'a' },
      { indent: 0, text: 'b' },
      { no: 3, text: 'c' },
    ]);
  });

  it('detail 行数超过 200 时截断', () => {
    const detail = Array.from({ length: 260 }, (_, i) => `第 ${i} 行`);
    expect(normalizeToolPresentation({ title: 'x', detail })?.detail).toHaveLength(200);
  });

  it('超长文本截断并加省略号', () => {
    const result = normalizeToolPresentation({ title: 'x', detail: ['y'.repeat(900)] });
    const line = result?.detail?.[0] as string;
    expect(line).toHaveLength(501);
    expect(line.endsWith('…')).toBe(true);
  });

  it('status 只接受白名单值', () => {
    expect(normalizeToolPresentation({ title: 'x', status: 'blocked' })?.status).toBe('blocked');
    expect(normalizeToolPresentation({ title: 'x', status: 'exploded' })?.status).toBeUndefined();
  });

  it('receipt 必须同时有 id 与 system 才保留', () => {
    expect(normalizeToolPresentation({ title: 'x', receipt: { id: 'A-1', system: '钉钉审批' } })?.receipt)
      .toEqual({ id: 'A-1', system: '钉钉审批' });
    expect(normalizeToolPresentation({ title: 'x', receipt: { id: 'A-1' } })?.receipt).toBeUndefined();
    expect(normalizeToolPresentation({ title: 'x', receipt: 'nope' })?.receipt).toBeUndefined();
  });

  it('receipt.readBack 仅在为布尔值时保留', () => {
    expect(normalizeToolPresentation({ title: 'x', receipt: { id: 'A', system: 'B', readBack: true } })?.receipt?.readBack).toBe(true);
    expect(normalizeToolPresentation({ title: 'x', receipt: { id: 'A', system: 'B', readBack: 'yes' } })?.receipt?.readBack).toBeUndefined();
  });
});
