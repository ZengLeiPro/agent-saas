import { describe, expect, it } from 'vitest';

import type { DetailLine } from './toolPresentation';
import {
  collectDetailKeyValues,
  groupDetailLines,
  isEmphasisValue,
  migrateLegacySectionVerdicts,
  statVerdict,
  visibleOutcomeStats,
} from './detailSemantics';

describe('isEmphasisValue', () => {
  it('数字 / 金额 / 比例 / 日期 / 时间进入强调白名单', () => {
    for (const value of ['1,234.5', '12.5%', '¥1,234.00', '17/18', '2026-08-03', '14:05', '3 个']) {
      expect(isEmphasisValue(value)).toBe(true);
    }
  });

  it('长句与含数字的业务文本不强调——否则整卡会被染成品牌色', () => {
    expect(isEmphasisValue('SO-1001 已回写')).toBe(false);
    expect(isEmphasisValue('')).toBe(false);
    expect(isEmphasisValue('1'.repeat(25))).toBe(false);
  });
});

describe('statVerdict', () => {
  it('只看 value，含数字一律判中性（计数值不上色）', () => {
    expect(statVerdict({ label: '失败', value: '0' })).toBeNull();
    expect(statVerdict({ label: '通过率', value: '17/18 通过' })).toBeNull();
  });

  it('否定式先于肯定式匹配', () => {
    expect(statVerdict({ label: '核对', value: '未通过' })).toBe('fail');
    expect(statVerdict({ label: '核对', value: '通过' })).toBe('pass');
    expect(statVerdict({ label: '核对', value: '✓' })).toBe('pass');
    expect(statVerdict({ label: '核对', value: '✗' })).toBe('fail');
  });

  it('空值与无法判定的文本退回中性', () => {
    expect(statVerdict({ label: '备注', value: '   ' })).toBeNull();
    expect(statVerdict({ label: '备注', value: '待复核' })).toBeNull();
  });
});

describe('visibleOutcomeStats', () => {
  const detail: DetailLine[] = [{ k: '差异', v: '19 条' }, { fields: [{ k: '一致', v: '61' }] }];

  it('与常显键值行同键同值的中性标签隐藏（含单位归一）', () => {
    expect(
      visibleOutcomeStats(
        [
          { label: '差异', value: '19' },
          { label: '一致', value: '61' },
        ],
        detail,
      ),
    ).toEqual([]);
  });

  it('判定类标签永远保留：它承载结论而不是数字', () => {
    expect(visibleOutcomeStats([{ label: '差异', value: '未通过' }], detail)).toEqual([
      { label: '差异', value: '未通过' },
    ]);
  });

  it('没有键值行时原样返回；没有标签时返回空数组', () => {
    expect(visibleOutcomeStats([{ label: 'a', value: 'b' }], [])).toEqual([
      { label: 'a', value: 'b' },
    ]);
    expect(visibleOutcomeStats(undefined, detail)).toEqual([]);
  });
});

describe('collectDetailKeyValues', () => {
  it('抽出 k/v 行与字段网格，忽略其他变体', () => {
    expect(
      collectDetailKeyValues([
        'plain',
        { k: '单号', v: 'SO-1' },
        { section: '小节' },
        { fields: [{ k: '金额', v: '¥1' }] },
      ]),
    ).toEqual([
      { label: '单号', value: 'SO-1' },
      { label: '金额', value: '¥1' },
    ]);
  });
});

describe('groupDetailLines', () => {
  it('连续 warn 行聚合，紧邻其前的小节标题被吸收为色块标题', () => {
    expect(groupDetailLines([{ section: '缺口' }, { warn: 'a' }, { warn: 'b' }, 'tail'])).toEqual([
      { kind: 'warnGroup', header: '缺口', warns: ['a', 'b'] },
      { kind: 'line', line: 'tail' },
    ]);
  });

  it('无前置小节时用默认标题，其余行顺序不变', () => {
    expect(groupDetailLines(['head', { warn: 'x' }])).toEqual([
      { kind: 'line', line: 'head' },
      { kind: 'warnGroup', header: '需要注意', warns: ['x'] },
    ]);
  });
});

describe('migrateLegacySectionVerdicts', () => {
  it('「小节 + 连续判定行」升格为 checklist 记录块', () => {
    expect(
      migrateLegacySectionVerdicts([
        'intro',
        { section: '判定' },
        { verdict: 'pass', text: '价格一致' },
        { verdict: 'fail', text: '交期不符', note: '差 2 天' },
        'tail',
      ]),
    ).toEqual([
      { kind: 'detail', lines: ['intro'] },
      {
        kind: 'records',
        block: {
          kind: 'records',
          layout: 'checklist',
          title: '判定',
          items: [
            { label: '价格一致', tone: 'success' },
            { label: '交期不符', tone: 'danger', note: '差 2 天' },
          ],
        },
      },
      { kind: 'detail', lines: ['tail'] },
    ]);
  });

  it('小节后不是判定行时不升格；空输入返回空数组', () => {
    expect(migrateLegacySectionVerdicts([{ section: 'a' }, 'b'])).toEqual([
      { kind: 'detail', lines: [{ section: 'a' }, 'b'] },
    ]);
    expect(migrateLegacySectionVerdicts(undefined)).toEqual([]);
  });
});
