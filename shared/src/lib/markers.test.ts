/**
 * markers.ts 测试（引用溯源卡批次，计划用例 1-3）
 *
 * 1. FILE+CITE 混排切分顺序正确，且纯 FILE 输入的输出与旧 splitByFileMarkers 逐行为等价
 * 2. CITE JSON 解析失败时整个 match 原样保留为文本（不吞不崩）
 * 3. stripPartialCiteMarker 只裁未闭合尾部，已闭合标记不受影响
 */
import { describe, expect, it } from 'vitest';
import { splitByMessageMarkers, stripPartialCiteMarker, parseCitationPayload } from './markers';

/** 旧 web splitByFileMarkers 的逐行为等价副本（MessageItem.tsx:213-235），用作回归基准 */
const FILE_MARKER_RE = /\[FILE\](\{.*?\})\[\/FILE\]/g;
type LegacySegment = { type: 'text'; content: string } | { type: 'file'; filePath: string; fileName: string };
function legacySplitByFileMarkers(text: string): LegacySegment[] {
  const segments: LegacySegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(FILE_MARKER_RE)) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: 'text', content: before });
    try {
      const json = JSON.parse(match[1]);
      const filePath = json.filePath || '';
      const fileName = filePath.split('/').pop() || filePath;
      segments.push({ type: 'file', filePath, fileName });
    } catch { /* malformed JSON — skip */ }
    lastIndex = match.index! + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim()) segments.push({ type: 'text', content: tail });
  return segments;
}

describe('splitByMessageMarkers', () => {
  it('用例1: FILE+CITE 混排切分顺序正确，纯 FILE 输出与旧逻辑一致', () => {
    // 混排：text → file → text → citation → tail
    const mixed = '前言 [FILE]{"filePath":"assets/报告.pdf"}[/FILE] 中段 '
      + '[CITE]{"doc":"catalog/接插件.pdf","page":12,"label":"接插件选型 p.12"}[/CITE] 收尾';
    const segments = splitByMessageMarkers(mixed);
    expect(segments).toEqual([
      { type: 'text', content: '前言 ' },
      { type: 'file', filePath: 'assets/报告.pdf', fileName: '报告.pdf' },
      { type: 'text', content: ' 中段 ' },
      { type: 'citation', doc: 'catalog/接插件.pdf', page: 12, label: '接插件选型 p.12' },
      { type: 'text', content: ' 收尾' },
    ]);

    // 兼容性红线：纯 FILE 输入（含 malformed JSON、缺 filePath、多标记、无尾文本）与旧逻辑逐字节一致
    const fileOnlyCases = [
      'a [FILE]{"filePath":"x/y.md"}[/FILE] b',
      '[FILE]{"filePath":"a.pdf"}[/FILE][FILE]{"filePath":"b/c.txt"}[/FILE]',
      'pre [FILE]{bad json}[/FILE] post',
      '[FILE]{"other":"no path"}[/FILE] tail',
      '   ',
      'no markers at all',
    ];
    for (const input of fileOnlyCases) {
      expect(splitByMessageMarkers(input)).toEqual(legacySplitByFileMarkers(input));
    }
  });

  it('用例2: CITE JSON 失败/doc 非法时整个 match 原样保留', () => {
    const badJson = '见 [CITE]{not-json}[/CITE] 说明';
    expect(splitByMessageMarkers(badJson)).toEqual([
      { type: 'text', content: '见 [CITE]{not-json}[/CITE] 说明' },
    ]);

    const missingDoc = '见 [CITE]{"page":3}[/CITE] 说明';
    expect(splitByMessageMarkers(missingDoc)).toEqual([
      { type: 'text', content: '见 [CITE]{"page":3}[/CITE] 说明' },
    ]);

    // 失败的 CITE 不影响后续合法标记的解析
    const mixedValidity = '[CITE]{oops}[/CITE] 然后 [CITE]{"doc":"a/b.pdf"}[/CITE]';
    expect(splitByMessageMarkers(mixedValidity)).toEqual([
      { type: 'text', content: '[CITE]{oops}[/CITE] 然后 ' },
      { type: 'citation', doc: 'a/b.pdf', label: 'b.pdf' },
    ]);

    // page 非正整数丢弃；label 缺省 = basename + p.N
    expect(parseCitationPayload('{"doc":"x/y.pdf","page":0}')).toEqual({ type: 'citation', doc: 'x/y.pdf', label: 'y.pdf' });
    expect(parseCitationPayload('{"doc":"x/y.pdf","page":2.5}')).toEqual({ type: 'citation', doc: 'x/y.pdf', label: 'y.pdf' });
    expect(parseCitationPayload('{"doc":"x/y.pdf","page":7}')).toEqual({ type: 'citation', doc: 'x/y.pdf', page: 7, label: 'y.pdf p.7' });
  });

  it('用例3: stripPartialCiteMarker 只裁未闭合尾部', () => {
    // 半截标记（流式中途）被裁掉
    expect(stripPartialCiteMarker('回答文本 [CITE]{"doc":"a.p')).toBe('回答文本 ');
    expect(stripPartialCiteMarker('回答文本 [CITE]')).toBe('回答文本 ');

    // 已闭合的标记完整保留
    const closed = '回答 [CITE]{"doc":"a.pdf"}[/CITE] 结束';
    expect(stripPartialCiteMarker(closed)).toBe(closed);

    // 前面闭合 + 尾部半截：只裁尾部
    expect(stripPartialCiteMarker('前 [CITE]{"doc":"a.pdf"}[/CITE] 后 [CITE]{"doc"'))
      .toBe('前 [CITE]{"doc":"a.pdf"}[/CITE] 后 ');

    // 无标记原样返回
    expect(stripPartialCiteMarker('plain text')).toBe('plain text');
  });
});
