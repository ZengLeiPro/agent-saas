/**
 * CSV 导出工具。全仓改造前 **0 处**导出能力（无 Blob / createObjectURL / download）。
 *
 * 本文件只提供纯函数与一个下载副作用，**不接任何页面**（接入是 S8 的事）。
 *
 * 四个必须处理的坑，逐条都有单测：
 * 1. **BOM**：不写 U+FEFF，中文在 Excel（尤其 Windows 简体）里必然乱码成「ä½ å¥½」。
 * 2. **转义**：逗号 / 双引号 / 换行 / 回车 / 首尾空格必须整段加引号，内部引号翻倍。
 * 3. **空值**：统一 `—`，与界面上的空值呈现保持一致（不要在导出里退回空白，
 *    那样「真的 0」和「没采到」在表格里又变得无法分辨）。
 * 4. **科学计数法**：长数字 ID（订单号、钉钉 userid）和带前导 0 的编号被 Excel
 *    改写成 `1.23457E+17` / `7`，是最常见的对外事故。用 `="…"` 强制文本。
 *    注意这条对 `number` 类型同样生效：Excel 只保 15 位有效数字，
 *    16 位以上的数即使是真数字也会丢精度，此时**保住数字本身比保住可计算性更重要**。
 *    真实指标（成本、耗时、次数）永远到不了 15 位，不受影响。
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

export interface CsvOptions {
  /** 空值占位，默认与界面一致的破折号 */
  emptyValue?: string;
  /** 是否写 UTF-8 BOM，默认 true（给 Excel 用）。喂给程序时可关。 */
  bom?: boolean;
  /** 行分隔符，默认 CRLF（Excel 友好） */
  newline?: "\r\n" | "\n";
  /**
   * 防止 Excel 把「像数字的字符串」改写：
   * - `formula`（默认）：包成 `="…"`，Excel / WPS 稳定按文本处理
   * - `none`：原样输出，交给消费方自己处理
   */
  numberSafety?: "formula" | "none";
}

/** 长到会被 Excel 转成科学计数法的纯数字串（15 位以上会丢精度） */
const LONG_DIGITS = /^[+-]?\d{15,}$/;
/** 带前导 0 的编号，Excel 会吃掉 0 */
const LEADING_ZERO = /^0\d+$/;
/** 已经写成科学计数法形态的字符串，Excel 会当数字重新格式化 */
const EXPONENT_FORM = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;

function needsTextForcing(text: string): boolean {
  return LONG_DIGITS.test(text) || LEADING_ZERO.test(text) || EXPONENT_FORM.test(text);
}

/** JS 对超大/超小数字的默认字符串化会带 e（1e21 → "1e+21"），先摊平 */
function numberToPlainString(value: number): string {
  const text = String(value);
  if (!text.includes("e") && !text.includes("E")) return text;
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/** 单元格取值 → 未加引号的原始文本 */
export function formatCsvValue(
  raw: string | number | boolean | null | undefined,
  options: CsvOptions = {},
): string {
  const emptyValue = options.emptyValue ?? "—";
  if (raw == null) return emptyValue;
  if (typeof raw === "boolean") return raw ? "是" : "否";
  if (typeof raw === "number") {
    // NaN / ±Infinity 在表格里无法表达，按空值处理
    if (!Number.isFinite(raw)) return emptyValue;
    return numberToPlainString(raw);
  }
  if (raw === "") return emptyValue;
  return raw;
}

/** 单个字段 → CSV 字段（含必要的引号与文本强制） */
export function escapeCsvField(text: string, options: CsvOptions = {}): string {
  const safety = options.numberSafety ?? "formula";
  if (safety === "formula" && needsTextForcing(text)) {
    return `="${text.replace(/"/g, '""')}"`;
  }
  const mustQuote = /[",\r\n]/.test(text) || text !== text.trim();
  if (!mustQuote) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** 行数据 + 列定义 → 完整 CSV 文本（默认含 BOM） */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], options: CsvOptions = {}): string {
  const newline = options.newline ?? "\r\n";
  const lines: string[] = [];
  // 表头本身也要转义：「历史成本（美元）」不含逗号，但「工具, 技能」这类列名会有
  lines.push(columns.map((column) => escapeCsvField(column.header, { ...options, numberSafety: "none" })).join(","));
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvField(formatCsvValue(column.value(row), options), options)).join(","));
  }
  const body = lines.join(newline) + newline;
  return (options.bom ?? true) ? `\uFEFF${body}` : body;
}

/** `runs-20260725-1930.csv`：文件名带时间戳，避免下载目录里一堆同名文件 */
export function csvFilename(prefix: string, at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const safePrefix = prefix.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-") || "export";
  return `${safePrefix}-${stamp}.csv`;
}

/** 触发浏览器下载。抽出来是为了让 toCsv 保持纯函数、可单测。 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 立刻 revoke 在部分浏览器会打断下载，退后一帧更稳
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 一步导出：`exportCsv(csvFilename("对话列表"), rows, columns)` */
export function exportCsv<T>(
  filename: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  options: CsvOptions = {},
): void {
  downloadCsv(filename, toCsv(rows, columns, options));
}
