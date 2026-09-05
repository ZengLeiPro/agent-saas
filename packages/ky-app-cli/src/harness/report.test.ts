/** 报告汇总：逐项状态、章节聚合、「没有任何检查项的章节算失败」与全绿判定。 */
import { describe, expect, it } from 'vitest';

import { CHAPTERS } from '../types.js';
import { Reporter, skip } from './report.js';

function silent(): { reporter: Reporter; lines: string[] } {
  const lines: string[] = [];
  return { reporter: new Reporter({ write: (line) => lines.push(line) }), lines };
}

/** 把 16 章全部填成 pass，方便只改其中一章看结论。 */
async function fillAll(reporter: Reporter): Promise<void> {
  for (const chapter of CHAPTERS) {
    reporter.section(chapter.no);
    await reporter.check(`${chapter.title} 占位`, () => undefined);
  }
}

describe('Reporter', () => {
  it('抛异常记 fail，抛 SkipCheck 记 skip', async () => {
    const { reporter } = silent();
    reporter.section(1);
    expect(await reporter.check('通过', () => undefined)).toBe('pass');
    expect(
      await reporter.check('失败', () => {
        throw new Error('炸了');
      }),
    ).toBe('fail');
    expect(
      await reporter.check('跳过', () => {
        skip('没有条件');
      }),
    ).toBe('skip');
    expect(reporter.totals()).toEqual({ passed: 1, failed: 1, skipped: 1 });
    expect(reporter.checks[1].reason).toBe('炸了');
    expect(reporter.checks[2].reason).toBe('没有条件');
  });

  it('每条结果都带章号与章名', async () => {
    const { reporter } = silent();
    reporter.section(5);
    await reporter.check('x', () => undefined);
    expect(reporter.checks[0]).toMatchObject({ chapter: 5, chapterTitle: 'read_only 能力' });
  });

  it('全部通过 → 全绿', async () => {
    const { reporter } = silent();
    await fillAll(reporter);
    expect(reporter.printSummary()).toBe(true);
  });

  it('有跳过项 → 不全绿', async () => {
    const { reporter } = silent();
    await fillAll(reporter);
    reporter.section(10);
    reporter.record('浏览器', 'skip', '没有 chromium');
    expect(reporter.printSummary()).toBe(false);
    expect(reporter.summarize().find((item) => item.chapter === 10)?.status).toBe('skip');
  });

  it('有失败项 → 不全绿，且该章状态为 fail', async () => {
    const { reporter } = silent();
    await fillAll(reporter);
    reporter.section(6);
    reporter.record('写能力', 'fail', '幂等键没校验');
    expect(reporter.printSummary()).toBe(false);
    expect(reporter.summarize().find((item) => item.chapter === 6)?.status).toBe('fail');
  });

  it('一条检查都没有的章节算失败（防止整章被漏跑）', async () => {
    const { reporter } = silent();
    reporter.section(1);
    await reporter.check('只跑了第一章', () => undefined);
    const summary = reporter.summarize();
    expect(summary.find((item) => item.chapter === 1)?.status).toBe('pass');
    expect(summary.find((item) => item.chapter === 2)?.status).toBe('fail');
    expect(reporter.printSummary()).toBe(false);
  });

  it('warn 进 warnings 并打印', () => {
    const { reporter, lines } = silent();
    reporter.warn('没找到浏览器');
    expect(reporter.warnings).toEqual(['没找到浏览器']);
    expect(lines.join('\n')).toContain('没找到浏览器');
  });

  it('汇总输出逐章一行 + 结论', async () => {
    const { reporter, lines } = silent();
    await fillAll(reporter);
    reporter.printSummary();
    const text = lines.join('\n');
    for (const chapter of CHAPTERS)
      expect(text).toContain(`§9.3-${String(chapter.no).padStart(2, ' ')}`);
    expect(text).toContain('结论：全绿');
  });
});
