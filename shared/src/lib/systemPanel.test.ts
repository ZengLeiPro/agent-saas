import { describe, expect, it } from 'vitest';
import {
  foldPanel,
  normalizePanelPatches,
  normalizeSystemPanel,
  type PanelPatch,
  type SystemPanelSnapshot,
} from './systemPanel';

const BASE: SystemPanelSnapshot = {
  activeView: 'kb',
  views: [
    {
      key: 'kb',
      label: '制度库',
      winTitle: '制度中心',
      widget: {
        kind: 'rows',
        rows: [
          { id: 'r1', text: '差旅管理办法' },
          { id: 'r2', text: '员工手册' },
        ],
      },
    },
    { key: 'stat', label: '档案', winTitle: '本人档案', widget: { kind: 'stats', items: [] } },
    { key: 'feed', label: '留痕', winTitle: '操作留痕', widget: { kind: 'feed', items: [] } },
    {
      key: 'tbl',
      label: '对账',
      winTitle: '对账表',
      widget: { kind: 'table', cols: [{ key: 'a', label: 'A' }], rows: [{ id: 't1', cells: { a: '1' } }] },
    },
  ],
};

describe('normalizeSystemPanel', () => {
  it('views 缺失或全非法时返回 null', () => {
    expect(normalizeSystemPanel(null)).toBeNull();
    expect(normalizeSystemPanel({ views: [] })).toBeNull();
    expect(normalizeSystemPanel({ views: [{ key: 'x' }] })).toBeNull();
  });

  it('activeView 非法时回落到首个 view', () => {
    const result = normalizeSystemPanel({ ...BASE, activeView: '不存在' });
    expect(result?.activeView).toBe('kb');
  });

  it('安全硬线：来自 transcript 的 custom HTML 一律丢弃并降级为空视图', () => {
    const raw = {
      activeView: 'x',
      views: [{ key: 'x', label: 'X', winTitle: 'X', widget: { kind: 'custom', html: '<script>alert(1)</script>' } }],
    };
    const fromTranscript = normalizeSystemPanel(raw);
    expect(fromTranscript?.views[0].widget.kind).toBe('rows');
    expect(JSON.stringify(fromTranscript)).not.toContain('script');
  });

  it('仅演示剧本来源（显式 allowCustomHtml）才保留 custom', () => {
    const raw = {
      activeView: 'x',
      views: [{ key: 'x', label: 'X', winTitle: 'X', widget: { kind: 'custom', html: '<b>ok</b>' } }],
    };
    const fromScript = normalizeSystemPanel(raw, true);
    expect(fromScript?.views[0].widget).toEqual({ kind: 'custom', html: '<b>ok</b>' });
  });

  it('view 数量与行数受上限约束', () => {
    const views = Array.from({ length: 20 }, (_, i) => ({
      key: `v${i}`, label: 'L', winTitle: 'W',
      widget: { kind: 'rows', rows: Array.from({ length: 400 }, (_, j) => ({ id: `r${j}`, text: 't' })) },
    }));
    const result = normalizeSystemPanel({ activeView: 'v0', views });
    expect(result!.views.length).toBe(6);
    const widget = result!.views[0].widget;
    expect(widget.kind === 'rows' && widget.rows.length).toBe(200);
  });

  it('丢弃非法行但保留同视图内的合法行', () => {
    const result = normalizeSystemPanel({
      activeView: 'x',
      views: [{ key: 'x', label: 'X', winTitle: 'X', widget: { kind: 'rows', rows: [{ id: 'a', text: 'ok' }, { text: '无 id' }, null] } }],
    });
    const widget = result!.views[0].widget;
    expect(widget.kind === 'rows' && widget.rows).toEqual([{ id: 'a', text: 'ok' }]);
  });
});

describe('normalizePanelPatches', () => {
  it('非数组或未知 op 一律丢弃', () => {
    expect(normalizePanelPatches(null)).toEqual([]);
    expect(normalizePanelPatches([{ op: '删库', view: 'kb' }])).toEqual([]);
  });

  it('保留合法 patch 并丢弃缺字段的', () => {
    const result = normalizePanelPatches([
      { op: 'focus', view: 'kb' },
      { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
      { op: 'rowUpdate', view: 'kb', set: { state: 'hit' } },
      { op: 'cellFlag', view: 'tbl', rowId: 't1', colKey: 'a', tone: '不存在' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ op: 'focus', view: 'kb' });
  });

  it('tone 白名单外的值被剥离', () => {
    const [patch] = normalizePanelPatches([{ op: 'rowUpdate', view: 'kb', id: 'r1', set: { tone: 'rainbow', state: 'hit' } }]);
    expect((patch as Extract<PanelPatch, { op: 'rowUpdate' }>).set).toEqual({ state: 'hit' });
  });

  it('rowsSet 只保留合法行，允许把当前对象集合替换为空', () => {
    expect(normalizePanelPatches([
      { op: 'rowsSet', view: 'kb', rows: [{ id: 'new', text: '新对象' }, { text: '无 id' }] },
      { op: 'rowsSet', view: 'kb', rows: [] },
    ])).toEqual([
      { op: 'rowsSet', view: 'kb', rows: [{ id: 'new', text: '新对象' }] },
      { op: 'rowsSet', view: 'kb', rows: [] },
    ]);
  });
});

describe('foldPanel', () => {
  it('focus 切换 activeView，指向不存在的视图时忽略', () => {
    expect(foldPanel(BASE, [{ op: 'focus', view: 'feed' }]).activeView).toBe('feed');
    expect(foldPanel(BASE, [{ op: 'focus', view: 'nope' }]).activeView).toBe('kb');
  });

  it('rowUpdate / rowsUpdate 按 id 命中', () => {
    const result = foldPanel(BASE, [
      { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
      { op: 'rowsUpdate', view: 'kb', ids: ['r2'], set: { state: 'excluded' } },
    ]);
    const widget = result.views[0].widget;
    expect(widget.kind === 'rows' && widget.rows.map((r) => r.state)).toEqual(['hit', 'excluded']);
  });

  it('rowInsert 支持定位插入与追加', () => {
    const result = foldPanel(BASE, [
      { op: 'rowInsert', view: 'kb', row: { id: 'x', text: '插队' }, at: 1 },
      { op: 'rowInsert', view: 'kb', row: { id: 'y', text: '末尾' } },
    ]);
    const widget = result.views[0].widget;
    expect(widget.kind === 'rows' && widget.rows.map((r) => r.id)).toEqual(['r1', 'x', 'r2', 'y']);
  });

  it('rowsSet 替换当前对象集合，不保留上一步占位或旧对象', () => {
    const result = foldPanel(BASE, [{
      op: 'rowsSet',
      view: 'kb',
      rows: [{ id: 'current', text: '本步唯一对象', state: 'hit' }],
    }]);
    const widget = result.views[0].widget;
    expect(widget.kind === 'rows' && widget.rows).toEqual([
      { id: 'current', text: '本步唯一对象', state: 'hit' },
    ]);
  });

  it('tableRowUpdate 只更新指定单元格，不丢失同一行的其他列和标记', () => {
    const snapshot: SystemPanelSnapshot = {
      activeView: 'tbl',
      views: [{
        key: 'tbl',
        label: '对账',
        winTitle: '对账表',
        widget: {
          kind: 'table',
          cols: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
          rows: [{
            id: 't1',
            cells: { a: '保留', b: '旧值' },
            flags: { a: { tone: 'pass' } },
          }],
        },
      }],
    };
    const result = foldPanel(snapshot, [{
      op: 'tableRowUpdate',
      view: 'tbl',
      id: 't1',
      set: { cells: { b: '新值' }, flags: { b: { tone: 'warn', flag: '待确认' } } },
    }]);
    const widget = result.views[0].widget;
    expect(widget.kind === 'table' && widget.rows[0]).toEqual({
      id: 't1',
      cells: { a: '保留', b: '新值' },
      flags: { a: { tone: 'pass' }, b: { tone: 'warn', flag: '待确认' } },
    });
  });

  it('cellFlag 落到表格单元格', () => {
    const result = foldPanel(BASE, [{ op: 'cellFlag', view: 'tbl', rowId: 't1', colKey: 'a', tone: 'deny', flag: '不符' }]);
    const widget = result.views[3].widget;
    expect(widget.kind === 'table' && widget.rows[0].flags?.a).toEqual({ tone: 'deny', flag: '不符' });
  });

  it('feedAppend 累加，statsSet 覆盖', () => {
    const result = foldPanel(BASE, [
      { op: 'feedAppend', view: 'feed', item: { id: 'f1', from: 'ai', text: '第一条' } },
      { op: 'feedAppend', view: 'feed', item: { id: 'f2', from: 'ai', text: '第二条' } },
      { op: 'statsSet', view: 'stat', items: [{ k: '职级', v: 'P5' }] },
    ]);
    const feed = result.views[2].widget;
    const stats = result.views[1].widget;
    expect(feed.kind === 'feed' && feed.items).toHaveLength(2);
    expect(stats.kind === 'stats' && stats.items).toEqual([{ k: '职级', v: 'P5' }]);
  });

  it('pulse 是瞬时动效，不改数据', () => {
    expect(foldPanel(BASE, [{ op: 'pulse', view: 'kb', ids: ['r1'], kind: 'hit' }])).toEqual(BASE);
  });

  it('op 与 widget 类型不匹配时静默跳过，不崩', () => {
    const result = foldPanel(BASE, [{ op: 'cardInsert', view: 'kb', card: { id: 'c', title: 't' } }]);
    expect(result.views[0].widget.kind).toBe('rows');
  });

  it('纯函数：不修改入参', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE)) as SystemPanelSnapshot;
    foldPanel(snapshot, [{ op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } }]);
    expect(snapshot).toEqual(BASE);
  });

  it('后退＝少喂 patch 即可复现历史状态（无需逆运算）', () => {
    const patches: PanelPatch[] = [
      { op: 'rowUpdate', view: 'kb', id: 'r1', set: { state: 'hit' } },
      { op: 'rowInsert', view: 'kb', row: { id: 'x', text: '新增' } },
      { op: 'focus', view: 'feed' },
    ];
    const atStep1 = foldPanel(BASE, patches.slice(0, 1));
    const forwardThenBack = foldPanel(BASE, patches.slice(0, 3));
    expect(foldPanel(BASE, patches.slice(0, 1))).toEqual(atStep1);
    expect(forwardThenBack.activeView).toBe('feed');
    expect(atStep1.activeView).toBe('kb');
  });
});
