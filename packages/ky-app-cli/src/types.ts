/** `ky-app doctor` 的公共类型：章节、逐项结果与报告。 */

/** §9.3 的 16 章。 */
export const CHAPTERS = [
  { no: 1, title: 'manifest 与 digest' },
  { no: 2, title: 'SAT 负向全表' },
  { no: 3, title: '端点 × act 全表' },
  { no: 4, title: 'jti 单次消费' },
  { no: 5, title: 'read_only 能力' },
  { no: 6, title: 'external_write 能力' },
  { no: 7, title: '页面 API ↔ 能力一致性' },
  { no: 8, title: '权限与菜单' },
  { no: 9, title: '响应头（生产构建产物）' },
  { no: 10, title: '浏览器 harness' },
  { no: 11, title: '本地兜底登录' },
  { no: 12, title: '组织目录' },
  { no: 13, title: '平台事件' },
  { no: 14, title: '密钥扫描' },
  { no: 15, title: '握手性能' },
  { no: 16, title: '契约版本' },
] as const;

export type ChapterNo = (typeof CHAPTERS)[number]['no'];

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  chapter: ChapterNo;
  /** 章节标题（冗余进每条，便于报告直接读）。 */
  chapterTitle: string;
  name: string;
  status: CheckStatus;
  /** 失败或跳过的原因（中文）。 */
  reason?: string;
  durationMs: number;
}

export interface ChapterSummary {
  chapter: ChapterNo;
  title: string;
  passed: number;
  failed: number;
  skipped: number;
  status: CheckStatus;
}

export interface DoctorReport {
  contractVersion: 1;
  /** 生成时刻 ISO 串。 */
  at: string;
  projectDir: string;
  systemId: string;
  manifestDigest: string;
  options: {
    pg: PgMode;
    browser: BrowserMode;
    databaseUrlSource: string;
  };
  /** 全绿 = 16 章无 fail 且无 skip。 */
  allGreen: boolean;
  totals: { passed: number; failed: number; skipped: number };
  chapters: ChapterSummary[];
  checks: CheckResult[];
  /** 非致命提醒（例如没找到浏览器）。 */
  warnings: string[];
}

export type PgMode = 'docker' | 'url' | 'skip';
export type BrowserMode = 'auto' | 'on' | 'off';

export interface DoctorOptions {
  projectDir: string;
  databaseUrl?: string;
  pg: PgMode;
  browser: BrowserMode;
  reportPath?: string;
  /** 只起 mock 壳（`--shell-only` / `ky-app mock-shell`），不跑一致性测试。 */
  shellOnly?: boolean;
}
