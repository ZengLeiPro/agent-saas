/** 逐项检查的收集、控制台输出与 `--report` JSON 汇总。 */
import { CHAPTERS, type ChapterNo, type ChapterSummary, type CheckResult } from '../types.js';

const ICON = { pass: '✅', fail: '❌', skip: '⏭️' } as const;

export class SkipCheck extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipCheck';
  }
}

/** 在检查体里调用即把该项记为 SKIP（并写明原因）。 */
export function skip(reason: string): never {
  throw new SkipCheck(reason);
}

export interface ReporterOptions {
  /** 输出一行的回调，默认 console.log。 */
  write?: (line: string) => void;
  now?: () => number;
}

export class Reporter {
  readonly checks: CheckResult[] = [];
  readonly warnings: string[] = [];
  private chapter: ChapterNo = 1;
  private chapterTitle = '';
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(options: ReporterOptions = {}) {
    this.write = options.write ?? ((line) => console.log(line));
    this.now = options.now ?? Date.now;
  }

  /** 进入某一章；打印标题。 */
  section(chapter: ChapterNo): void {
    const meta = CHAPTERS.find((item) => item.no === chapter);
    this.chapter = chapter;
    this.chapterTitle = meta?.title ?? '';
    this.write('');
    this.write(`── §9.3-${String(chapter)} ${this.chapterTitle}`);
  }

  warn(message: string): void {
    this.warnings.push(message);
    this.write(`   ⚠️  ${message}`);
  }

  /** 跑一项检查。抛 `SkipCheck` 记 SKIP，其余异常记 FAIL。 */
  async check(name: string, run: () => Promise<void> | void): Promise<CheckStatusLite> {
    const startedAt = this.now();
    let status: CheckStatusLite = 'pass';
    let reason: string | undefined;
    try {
      await run();
    } catch (error) {
      if (error instanceof SkipCheck) {
        status = 'skip';
        reason = error.message;
      } else {
        status = 'fail';
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    const durationMs = this.now() - startedAt;
    this.checks.push({
      chapter: this.chapter,
      chapterTitle: this.chapterTitle,
      name,
      status,
      ...(reason === undefined ? {} : { reason }),
      durationMs,
    });
    this.write(
      `   ${ICON[status]} ${name}${reason === undefined ? '' : `（${truncate(reason)}）`}`,
    );
    return status;
  }

  /** 直接记一项（供批量循环里已经算好结果的场景）。 */
  record(name: string, status: CheckStatusLite, reason?: string): void {
    this.checks.push({
      chapter: this.chapter,
      chapterTitle: this.chapterTitle,
      name,
      status,
      ...(reason === undefined ? {} : { reason }),
      durationMs: 0,
    });
    this.write(
      `   ${ICON[status]} ${name}${reason === undefined ? '' : `（${truncate(reason)}）`}`,
    );
  }

  summarize(): ChapterSummary[] {
    return CHAPTERS.map((meta) => {
      const own = this.checks.filter((check) => check.chapter === meta.no);
      const failed = own.filter((check) => check.status === 'fail').length;
      const skipped = own.filter((check) => check.status === 'skip').length;
      const passed = own.filter((check) => check.status === 'pass').length;
      const status: CheckStatusLite =
        failed > 0 || own.length === 0 ? 'fail' : skipped > 0 ? 'skip' : 'pass';
      return { chapter: meta.no, title: meta.title, passed, failed, skipped, status };
    });
  }

  totals(): { passed: number; failed: number; skipped: number } {
    return {
      passed: this.checks.filter((check) => check.status === 'pass').length,
      failed: this.checks.filter((check) => check.status === 'fail').length,
      skipped: this.checks.filter((check) => check.status === 'skip').length,
    };
  }

  /** 16 章逐章一行的汇总表 + 总计。 */
  printSummary(): boolean {
    const chapters = this.summarize();
    const totals = this.totals();
    this.write('');
    this.write('════ §9.3 一致性测试汇总 ════');
    for (const chapter of chapters) {
      const missing =
        chapter.passed + chapter.failed + chapter.skipped === 0 ? '（本章没有任何检查项）' : '';
      this.write(
        `${ICON[chapter.status]} §9.3-${String(chapter.chapter).padStart(2, ' ')} ${chapter.title.padEnd(22, ' ')}` +
          ` 通过 ${String(chapter.passed)}／失败 ${String(chapter.failed)}／跳过 ${String(chapter.skipped)}${missing}`,
      );
    }
    const allGreen =
      totals.failed === 0 && totals.skipped === 0 && chapters.every((c) => c.status === 'pass');
    this.write('');
    this.write(
      `合计：通过 ${String(totals.passed)}，失败 ${String(totals.failed)}，跳过 ${String(totals.skipped)}`,
    );
    this.write(allGreen ? '结论：全绿 ✅' : '结论：未全绿 ❌（存在失败或跳过项）');
    return allGreen;
  }
}

export type CheckStatusLite = 'pass' | 'fail' | 'skip';

function truncate(text: string, max = 200): string {
  const flat = text.replaceAll('\n', ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
