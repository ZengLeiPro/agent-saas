import { describe, expect, it } from "vitest";
import React from "react";
import {
  estimateTextWidthPx,
  extractTextFromChildren,
  getCellMinWidthPx,
} from "./tableCellWidth";

describe("extractTextFromChildren", () => {
  it("null / boolean 返回空串", () => {
    expect(extractTextFromChildren(null)).toBe("");
    expect(extractTextFromChildren(undefined)).toBe("");
    expect(extractTextFromChildren(true)).toBe("");
    expect(extractTextFromChildren(false)).toBe("");
  });

  it("string / number 直接转字符串", () => {
    expect(extractTextFromChildren("abc")).toBe("abc");
    expect(extractTextFromChildren(123)).toBe("123");
    expect(extractTextFromChildren(0)).toBe("0");
  });

  it("数组递归拼接（含混合类型）", () => {
    expect(extractTextFromChildren(["a", 1, null, "b"])).toBe("a1b");
  });

  it("React 元素递归取其 children", () => {
    const el = React.createElement("span", null, "内层", React.createElement("b", null, "粗"));
    expect(extractTextFromChildren(el)).toBe("内层粗");
  });

  it("无 children 的元素返回空串", () => {
    const el = React.createElement("br");
    expect(extractTextFromChildren(el)).toBe("");
  });
});

describe("estimateTextWidthPx", () => {
  it("CJK 汉字按 1em 计（默认 14px）", () => {
    expect(estimateTextWidthPx("中")).toBeCloseTo(14);
    expect(estimateTextWidthPx("中文")).toBeCloseTo(28);
  });

  it("空格按 0.27em、其它 ASCII 按 0.54em", () => {
    expect(estimateTextWidthPx(" ")).toBeCloseTo(14 * 0.27);
    expect(estimateTextWidthPx("a")).toBeCloseTo(14 * 0.54);
  });

  it("覆盖各宽字符区间：CJK 标点/全角/平假名/片假名/谚文", () => {
    // 每个都落在 1em 分支
    for (const ch of ["，", "Ａ", "あ", "ア", "가"]) {
      expect(estimateTextWidthPx(ch, 10)).toBeCloseTo(10);
    }
  });

  it("自定义字号缩放线性生效", () => {
    expect(estimateTextWidthPx("中", 20)).toBeCloseTo(20);
    expect(estimateTextWidthPx("a", 20)).toBeCloseTo(20 * 0.54);
  });

  it("空串宽度为 0", () => {
    expect(estimateTextWidthPx("")).toBe(0);
  });
});

describe("getCellMinWidthPx", () => {
  it("空文本返回下限 56", () => {
    expect(getCellMinWidthPx("")).toBe(56);
  });

  it("短文本被下限兜底为 56", () => {
    // 一个汉字 14px / 4 行 + 12 pad = 15.5 < 56
    expect(getCellMinWidthPx("短")).toBe(56);
  });

  it("长文本按 ⌈宽度/行数⌉ + padding 推高列宽", () => {
    const text = "中".repeat(40); // 40*14 = 560px
    // ceil(560/4) + 12 = 140 + 12 = 152
    expect(getCellMinWidthPx(text)).toBe(152);
  });

  it("maxLines 越大列宽越窄", () => {
    const text = "中".repeat(40);
    expect(getCellMinWidthPx(text, 2)).toBeGreaterThan(getCellMinWidthPx(text, 8));
  });
});
