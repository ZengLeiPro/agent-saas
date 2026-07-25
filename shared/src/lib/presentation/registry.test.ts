import { describe, expect, it } from 'vitest';
import { BLOCK_NORMALIZERS, listBlockKinds, normalizeDisplay } from './registry';

describe('normalizeDisplay', () => {
  it('非数组返回 null', () => {
    expect(normalizeDisplay(null)).toBeNull();
    expect(normalizeDisplay({ kind: 'callout' })).toBeNull();
  });

  it('未知 kind 静默丢弃——旧客户端读到新快照不崩，是分享链路的前后兼容红线', () => {
    const result = normalizeDisplay([
      { kind: '未来才有的块', body: ['x'] },
      { kind: 'callout', tone: 'info', body: ['保留'] },
    ]);
    expect(result).toHaveLength(1);
    expect(result![0].kind).toBe('callout');
  });

  it('全部非法时返回 null 而非空数组', () => {
    expect(normalizeDisplay([{ kind: 'unknown' }, null, 42])).toBeNull();
  });

  it('块数量受上限约束', () => {
    const many = Array.from({ length: 80 }, () => ({ kind: 'callout', tone: 'info', body: ['x'] }));
    expect(normalizeDisplay(many)).toHaveLength(40);
  });
});

describe('callout', () => {
  it('tone 非法时回落 neutral，正文归一为数组', () => {
    const [block] = normalizeDisplay([{ kind: 'callout', tone: '彩虹色', body: '单行也接受' }])!;
    expect(block).toEqual({ kind: 'callout', tone: 'neutral', body: ['单行也接受'] });
  });

  it('正文与依据行同时为空时丢弃，不渲染空壳', () => {
    expect(normalizeDisplay([{ kind: 'callout', tone: 'info', body: [] }])).toBeNull();
  });

  it('只有 detail 也成立——「结论 + 依据行」里结论可以省', () => {
    const [block] = normalizeDisplay([{ kind: 'callout', tone: 'warn', detail: [{ k: '缺口', v: '3 处' }] }])!;
    expect(block.kind === 'callout' && block.detail).toEqual([{ k: '缺口', v: '3 处' }]);
  });
});

describe('records', () => {
  it('items 全空时丢弃', () => {
    expect(normalizeDisplay([{ kind: 'records', layout: 'rows', items: [] }])).toBeNull();
    expect(normalizeDisplay([{ kind: 'records', items: [{ value: '无 label' }] }])).toBeNull();
  });

  it('layout 非法时回落 rows', () => {
    const [block] = normalizeDisplay([{ kind: 'records', layout: '瀑布流', items: [{ label: 'a' }] }])!;
    expect(block.kind === 'records' && block.layout).toBe('rows');
  });

  it('条目保留 tag/tone/mono/detail', () => {
    const [block] = normalizeDisplay([{
      kind: 'records',
      items: [{ label: '合同号', value: 'HT-001', tag: { tone: 'success', text: '已核对' }, tone: 'warn', mono: true, detail: ['来源：合同库'] }],
    }])!;
    expect(block.kind === 'records' && block.items[0]).toEqual({
      label: '合同号',
      value: 'HT-001',
      tag: { tone: 'success', text: '已核对' },
      tone: 'warn',
      mono: true,
      detail: ['来源：合同库'],
    });
  });
});

describe('gate', () => {
  it('没有动作的门禁被丢弃——那是 callout，不允许伪装', () => {
    expect(normalizeDisplay([{ kind: 'gate', title: '请确认' }])).toBeNull();
    expect(normalizeDisplay([{ kind: 'gate', title: '请确认', actions: [] }])).toBeNull();
  });

  it('保留 meta 键值与动作', () => {
    const [block] = normalizeDisplay([{
      kind: 'gate',
      title: '需要人工确认',
      body: ['该操作会写入外部系统'],
      meta: [{ k: '目标', v: '钉钉审批' }, { k: '不合法' }],
      actions: [{ kind: 'primary', label: '批准', interactionId: 'i-1' }],
    }])!;
    expect(block.kind === 'gate' && block.meta).toEqual([{ k: '目标', v: '钉钉审批' }, { k: '不合法', v: '' }]);
    expect(block.kind === 'gate' && block.actions).toHaveLength(1);
  });

  it('动作 kind 非白名单时丢弃该动作', () => {
    expect(normalizeDisplay([{
      kind: 'gate',
      title: 't',
      actions: [{ kind: '自定义炫酷按钮', label: 'x' }],
    }])).toBeNull();
  });
});

describe('注册表', () => {
  it('注册表被冻结——避免运行时被改出难以定位的行为差异', () => {
    expect(Object.isFrozen(BLOCK_NORMALIZERS)).toBe(true);
  });

  it('kind 列表与注册表键一致', () => {
    expect(listBlockKinds().sort()).toEqual(['callout', 'gate', 'records']);
  });

  it('每个 kind 的 normalizer 面对垃圾输入都返回 null 而非抛错', () => {
    for (const [kind, normalize] of Object.entries(BLOCK_NORMALIZERS)) {
      expect(() => normalize({} as never), kind).not.toThrow();
      expect(normalize({} as never), kind).toBeNull();
    }
  });
});
