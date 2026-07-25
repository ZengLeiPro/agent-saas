/**
 * CSV 导出的行为契约。
 *
 * 为什么值得单测：这是全仓第一处导出能力，而 CSV 的坑全部是**静默**的——
 * 没有 BOM 就中文乱码、没有转义就整行错位、长数字 ID 被 Excel 改写成科学计数法。
 * 这些错误不会抛异常，只会在客户打开文件时才暴露，因此必须在单测里锁死。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { csvFilename, downloadCsv, escapeCsvField, formatCsvValue, toCsv, type CsvColumn } from "./exportCsv";

interface Row {
  name: string;
  count: number | null;
  note?: string | null;
  ok?: boolean;
}

const COLUMNS: CsvColumn<Row>[] = [
  { header: "名称", value: (row) => row.name },
  { header: "次数", value: (row) => row.count },
  { header: "备注", value: (row) => row.note },
];

const BOM = "﻿";

function lines(csv: string): string[] {
  return csv.replace(BOM, "").split("\r\n").filter((line) => line.length > 0);
}

describe("toCsv", () => {
  it("默认带 UTF-8 BOM —— 少了它 Excel 打开中文必然乱码", () => {
    const csv = toCsv([{ name: "开沿科技", count: 1 }], COLUMNS);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("bom:false 时不写 BOM（喂给程序而非 Excel）", () => {
    expect(toCsv([], COLUMNS, { bom: false }).startsWith(BOM)).toBe(false);
  });

  it("默认用 CRLF 换行，行尾也补一个换行", () => {
    const csv = toCsv([{ name: "甲", count: 1 }], COLUMNS, { bom: false });
    expect(csv).toBe("名称,次数,备注\r\n甲,1,—\r\n");
  });

  it("第一行是表头，行数 = 表头 + 数据行", () => {
    const csv = toCsv([{ name: "甲", count: 1 }, { name: "乙", count: 2 }], COLUMNS);
    expect(lines(csv)).toHaveLength(3);
    expect(lines(csv)[0]).toBe("名称,次数,备注");
  });

  it("零行时仍输出表头（不是空文件）", () => {
    expect(lines(toCsv([], COLUMNS))).toEqual(["名称,次数,备注"]);
  });

  it("null / undefined / 空串统一导出为「—」，与界面空值呈现一致", () => {
    const csv = toCsv([{ name: "", count: null, note: undefined }], COLUMNS, { bom: false });
    expect(lines(csv)[1]).toBe("—,—,—");
  });

  it("emptyValue 可覆盖", () => {
    const csv = toCsv([{ name: "甲", count: null }], COLUMNS, { bom: false, emptyValue: "" });
    expect(lines(csv)[1]).toBe("甲,,");
  });

  it("数字 0 是真实值，不能被当成空值吃掉", () => {
    const csv = toCsv([{ name: "甲", count: 0 }], COLUMNS, { bom: false });
    expect(lines(csv)[1]).toBe("甲,0,—");
  });
});

describe("escapeCsvField", () => {
  it("含逗号 → 整段加引号", () => {
    expect(escapeCsvField("甲, 乙")).toBe('"甲, 乙"');
  });

  it("含双引号 → 加引号且内部引号翻倍", () => {
    expect(escapeCsvField('说"你好"')).toBe('"说""你好"""');
  });

  it("含换行 / 回车 → 加引号（否则整行错位）", () => {
    expect(escapeCsvField("第一行\n第二行")).toBe('"第一行\n第二行"');
    expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("首尾空格 → 加引号，避免被消费方 trim 掉", () => {
    expect(escapeCsvField(" 甲 ")).toBe('" 甲 "');
  });

  it("普通文本不加引号", () => {
    expect(escapeCsvField("开沿科技")).toBe("开沿科技");
  });
});

describe("防 Excel 科学计数法 / 吃前导 0", () => {
  it("15 位以上纯数字串包成 =\"…\"", () => {
    expect(escapeCsvField("123456789012345678")).toBe('="123456789012345678"');
  });

  it("14 位及以下不折腾（Excel 能正常显示）", () => {
    expect(escapeCsvField("12345678901234")).toBe("12345678901234");
  });

  it("带前导 0 的编号强制文本，否则 007 会变成 7", () => {
    expect(escapeCsvField("007")).toBe('="007"');
  });

  it("已经是 1.23E+18 形态的字符串也强制文本", () => {
    expect(escapeCsvField("1.23E+18")).toBe('="1.23E+18"');
  });

  it("numberSafety:none 时原样输出", () => {
    expect(escapeCsvField("007", { numberSafety: "none" })).toBe("007");
  });

  it("表头永不被当成数字处理（内部固定 none）", () => {
    const csv = toCsv<{ id: string }>([], [{ header: "007", value: (row) => row.id }], { bom: false });
    expect(csv.trim()).toBe("007");
  });

  it("常规量级的数字保持裸值，Excel 里仍可参与计算", () => {
    const csv = toCsv<{ n: number }>([{ n: 12345.67 }], [{ header: "n", value: (r) => r.n }], { bom: false });
    expect(lines(csv)[1]).toBe("12345.67");
  });

  it("16 位以上的真数字也强制文本 —— Excel 只保 15 位有效数字，保数字本身优先", () => {
    const csv = toCsv<{ n: number }>([{ n: 1234567890123456 }], [{ header: "n", value: (r) => r.n }], { bom: false });
    expect(lines(csv)[1]).toBe('="1234567890123456"');
  });

  it("JS 自身的指数字符串化被摊平（1e21 不写成 1e+21）", () => {
    expect(formatCsvValue(1e21)).toBe("1000000000000000000000");
  });
});

describe("formatCsvValue", () => {
  it("布尔按中文是/否", () => {
    expect(formatCsvValue(true)).toBe("是");
    expect(formatCsvValue(false)).toBe("否");
  });

  it("NaN 视为空值", () => {
    expect(formatCsvValue(Number.NaN)).toBe("—");
  });

  it("±Infinity 视为空值（无法在表格里表达）", () => {
    expect(formatCsvValue(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCsvValue(Number.NEGATIVE_INFINITY)).toBe("—");
  });
});

describe("csvFilename", () => {
  it("拼上 yyyyMMdd-HHmm 与 .csv 后缀", () => {
    expect(csvFilename("对话列表", new Date(2026, 6, 25, 19, 5))).toBe("对话列表-20260725-1905.csv");
  });

  it("剔除文件名非法字符与空格", () => {
    expect(csvFilename("a/b:c d", new Date(2026, 0, 2, 3, 4))).toBe("a-b-c-d-20260102-0304.csv");
  });

  it("前缀为空时兜底 export", () => {
    expect(csvFilename("", new Date(2026, 0, 2, 3, 4))).toBe("export-20260102-0304.csv");
  });
});

describe("downloadCsv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("创建 a[download] 并点击，随后释放 objectURL", () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadCsv("x.csv", "a,b\r\n");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    // 点完就摘掉，不在 DOM 里留残渣
    expect(document.querySelector("a[download]")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("文件名缺 .csv 时自动补", () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }));
    let seen = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      seen = this.getAttribute("download") ?? "";
    });

    downloadCsv("导出", "a\r\n");

    expect(seen).toBe("导出.csv");
    vi.unstubAllGlobals();
  });
});
