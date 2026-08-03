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

  it('保留第二批 7 种 detail 变体（demo 高频块）', () => {
    const result = normalizeToolPresentation({
      title: '判定与结论',
      detail: [
        { section: '动作 1 · 写入脱敏副本' },
        { warn: '供电与结构承重未确认' },
        { insight: '当前状态不能点 Tape-out', label: '结论' },
        { risk: 'high', text: '跨系统差异率 0.43%', action: '先止损再复验' },
        { verdict: 'pass', text: '域名与地址一致', note: '两个独立来源' },
        { quote: '新签的合同一律写七天', source: 'T-0142 [01:08:12]' },
        { original: 'need CE cert before Q4 delivery', translation: 'Q4 交付前需完成 CE 认证' },
      ],
    });
    expect(result?.detail).toEqual([
      { section: '动作 1 · 写入脱敏副本' },
      { warn: '供电与结构承重未确认' },
      { insight: '当前状态不能点 Tape-out', label: '结论' },
      { risk: 'high', text: '跨系统差异率 0.43%', action: '先止损再复验' },
      { verdict: 'pass', text: '域名与地址一致', note: '两个独立来源' },
      { quote: '新签的合同一律写七天', source: 'T-0142 [01:08:12]' },
      { original: 'need CE cert before Q4 delivery', translation: 'Q4 交付前需完成 CE 认证' },
    ]);
  });

  it('字段网格：合法字段保留、脏条目丢弃、超过 12 个截断', () => {
    const result = normalizeToolPresentation({
      title: '抽取询价字段',
      detail: [
        { fields: [{ k: '预算', v: '$120,000' }, { k: '交期', v: '2026 Q4' }, { nope: 1 }, { k: '  ' }, { k: '认证' }] },
      ],
    });
    expect(result?.detail).toEqual([
      { fields: [{ k: '预算', v: '$120,000' }, { k: '交期', v: '2026 Q4' }, { k: '认证', v: '' }] },
    ]);

    const overflow = normalizeToolPresentation({
      title: 'x',
      detail: [{ fields: Array.from({ length: 20 }, (_, i) => ({ k: `字段${i}`, v: `${i}` })) }],
    });
    const grid = overflow?.detail?.[0] as { fields: unknown[] };
    expect(grid.fields).toHaveLength(12);
  });

  it('字段网格全部条目非法时整行丢弃', () => {
    expect(normalizeToolPresentation({ title: 'x', detail: [{ fields: [{ v: '没有键' }, 'nope'] }] })?.detail)
      .toBeUndefined();
    expect(normalizeToolPresentation({ title: 'x', detail: [{ fields: [] }] })?.detail).toBeUndefined();
  });

  it('第二批变体的可选字段缺失时不产出该字段', () => {
    const result = normalizeToolPresentation({
      title: 'x',
      detail: [
        { insight: '只有主句' },
        { risk: 'medium', text: '事实' },
        { verdict: 'warn', text: '需注意' },
        { quote: '原话' },
        { original: 'plain original' },
      ],
    });
    expect(result?.detail).toEqual([
      { insight: '只有主句' },
      { risk: 'medium', text: '事实' },
      { verdict: 'warn', text: '需注意' },
      { quote: '原话' },
      { original: 'plain original' },
    ]);
  });

  it('第二批变体的枚举值非法时整行丢弃', () => {
    const result = normalizeToolPresentation({
      title: 'x',
      detail: [
        { risk: 'catastrophic', text: 'a' },
        { verdict: 'maybe', text: 'b' },
        { k: '保留', v: 'v' },
      ],
    });
    expect(result?.detail).toEqual([{ k: '保留', v: 'v' }]);
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

  // —— 回执白名单化：id 直接来自外部系统 stdout（不可信），却被渲染在
  //    「系统盖章」的高可信位置。宁可不盖章，不可盖错章。——
  describe('receipt 白名单化', () => {
    const receiptOf = (receipt: unknown) => normalizeToolPresentation({ title: 'x', receipt })?.receipt;

    it('超长 id 整条作废——单据号不可能有 120 字符', () => {
      expect(receiptOf({ id: 'A'.repeat(121), system: '钉钉' })).toBeUndefined();
      expect(receiptOf({ id: 'A'.repeat(120), system: '钉钉' })).toEqual({ id: 'A'.repeat(120), system: '钉钉' });
    });

    it('带空白或控制字符的 id 作废', () => {
      expect(receiptOf({ id: 'A-1 B-2', system: '钉钉' })).toBeUndefined();
      expect(receiptOf({ id: 'A-1\n伪造成功', system: '钉钉' })).toBeUndefined();
    });

    it('白名单域名的 https 链接可作 id，非白名单域名一律拒绝', () => {
      expect(receiptOf({ id: 'https://shanji.dingtalk.com/app/transcribes/1', system: '钉钉' }))
        .toEqual({ id: 'https://shanji.dingtalk.com/app/transcribes/1', system: '钉钉' });
      expect(receiptOf({ id: 'https://open.feishu.cn/doc/1', system: '飞书' })).toBeTruthy();
      expect(receiptOf({ id: 'https://evil.example.com/phish', system: '钉钉' })).toBeUndefined();
      expect(receiptOf({ id: 'https://evilfeishu.cn/phish', system: '飞书' })).toBeUndefined();
    });

    it('非 https scheme 一律拒绝（javascript: / data: / http:）', () => {
      expect(receiptOf({ id: 'javascript:alert(1)', system: '钉钉' })).toBeUndefined();
      expect(receiptOf({ id: 'data:text/html;base64,PHN2Zz4=', system: '钉钉' })).toBeUndefined();
      expect(receiptOf({ id: 'http://shanji.dingtalk.com/x', system: '钉钉' })).toBeUndefined();
    });

    it('system 有独立长度上限且不得是链接', () => {
      expect(receiptOf({ id: 'A-1', system: '系'.repeat(41) })).toBeUndefined();
      expect(receiptOf({ id: 'A-1', system: 'https://evil.example.com' })).toBeUndefined();
    });
  });
});
