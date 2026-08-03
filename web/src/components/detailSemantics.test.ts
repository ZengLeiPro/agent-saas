import { describe, expect, it } from "vitest";
import type { DetailLine } from "@agent/shared";

import {
  collectDetailKeyValues,
  isEmphasisValue,
  statVerdict,
  visibleOutcomeStats,
} from "./detailSemantics";

describe("isEmphasisValue", () => {
  it("认定数字 / 金额 / 比例 / 日期 / 时间为关键值", () => {
    for (const v of ["15", "1,234", "12.5%", "¥1,200.00", "3 个", "17/18", "2026-08-03", "08-03", "14:05"]) {
      expect(isEmphasisValue(v), v).toBe(true);
    }
  });

  it("句子、纯文本与超长值不强调", () => {
    for (const v of ["已回写 SO-1001 并完成回读校验", "通过", "", "订单资料完整", "0123456789012345678901234567890"]) {
      expect(isEmphasisValue(v), v).toBe(false);
    }
  });
});

describe("statVerdict", () => {
  it("符号与判定词给出绿/红语义", () => {
    expect(statVerdict({ label: "一致性", value: "✓" })).toBe("pass");
    expect(statVerdict({ label: "一致性", value: "通过" })).toBe("pass");
    expect(statVerdict({ label: "税号", value: "✗" })).toBe("fail");
    expect(statVerdict({ label: "税号", value: "未通过" })).toBe("fail");
  });

  it("否定式优先于肯定式：「未通过」不能被「通过」抢走", () => {
    expect(statVerdict({ label: "判定", value: "不满足" })).toBe("fail");
    expect(statVerdict({ label: "判定", value: "未达标" })).toBe("fail");
  });

  it("只看 value，不看 label：「失败 0」是好消息，不能染红", () => {
    expect(statVerdict({ label: "失败", value: "0" })).toBeNull();
    expect(statVerdict({ label: "异常", value: "0" })).toBeNull();
  });

  it("含数字的值一律判中性——宁可不上色，不误上色", () => {
    expect(statVerdict({ label: "校验", value: "17/18 通过" })).toBeNull();
    expect(statVerdict({ label: "缺口", value: "0 项异常" })).toBeNull();
    expect(statVerdict({ label: "文件夹", value: "15" })).toBeNull();
  });

  it("空值与无语义文本保持中性", () => {
    expect(statVerdict({ label: "其他", value: "" })).toBeNull();
    expect(statVerdict({ label: "来源", value: "钉钉云盘" })).toBeNull();
  });
});

describe("collectDetailKeyValues", () => {
  it("抽出 k/v 行、树形 k/v 行与字段网格，忽略其他行型", () => {
    const detail: DetailLine[] = [
      "纯文本行",
      { k: "文件夹", v: "15" },
      { tree: "├", k: "文件", v: "3" },
      { section: "小节" },
      { warn: "缺依据" },
      { verdict: "pass", text: "资料完整" },
      { fields: [{ k: "预算", v: "$120,000" }] },
    ];
    expect(collectDetailKeyValues(detail)).toEqual([
      { label: "文件夹", value: "15" },
      { label: "文件", value: "3" },
      { label: "预算", value: "$120,000" },
    ]);
  });

  it("空输入安全", () => {
    expect(collectDetailKeyValues()).toEqual([]);
    expect(collectDetailKeyValues([])).toEqual([]);
  });
});

describe("visibleOutcomeStats（槽位去重）", () => {
  const detail: DetailLine[] = [
    { k: "文件夹", v: "15" },
    { k: "文件", v: "3" },
    { k: "其他", v: "0" },
  ];
  const stats = [
    { label: "文件夹", value: "15" },
    { label: "文件", value: "3" },
    { label: "其他", value: "0" },
  ];

  it("隐藏与常显详情行同键同值的中性标签", () => {
    expect(visibleOutcomeStats(stats, detail)).toEqual([]);
  });

  it("只隐藏命中的那几个，未命中的原样保留", () => {
    const mixed = [...stats, { label: "耗时", value: "42s" }];
    expect(visibleOutcomeStats(mixed, detail)).toEqual([{ label: "耗时", value: "42s" }]);
  });

  it("判定类标签始终显示，哪怕详情里有同键同值的行", () => {
    const withVerdict = [{ label: "合规", value: "通过" }, { label: "文件夹", value: "15" }];
    const detailWithVerdict: DetailLine[] = [{ k: "合规", v: "通过" }, { k: "文件夹", v: "15" }];
    expect(visibleOutcomeStats(withVerdict, detailWithVerdict)).toEqual([
      { label: "合规", value: "通过" },
    ]);
  });

  it("键相同但值不同不算重复——宁可少隐藏，不可误隐藏", () => {
    expect(visibleOutcomeStats([{ label: "文件", value: "30" }], detail)).toEqual([
      { label: "文件", value: "30" },
    ]);
  });

  it("值相同但键不同不算重复", () => {
    expect(visibleOutcomeStats([{ label: "目录", value: "15" }], detail)).toEqual([
      { label: "目录", value: "15" },
    ]);
  });

  it("归一化容忍空白、全角数字与计量单位后缀", () => {
    const noisy = [
      { label: " 文件夹 ", value: "１５" },
      { label: "文件", value: "3 个" },
    ];
    expect(visibleOutcomeStats(noisy, detail)).toEqual([]);
  });

  it("单位剥离要求前面是数字：「文件」不会被剥成「文」", () => {
    const detailWord: DetailLine[] = [{ k: "类型", v: "文" }];
    expect(visibleOutcomeStats([{ label: "类型", value: "文件" }], detailWord)).toEqual([
      { label: "类型", value: "文件" },
    ]);
  });

  it("详情里没有键值行时不隐藏任何标签", () => {
    const textOnly: DetailLine[] = ["共核验 12 项字段", { verdict: "pass", text: "资料完整" }];
    expect(visibleOutcomeStats(stats, textOnly)).toEqual(stats);
    expect(visibleOutcomeStats(stats, undefined)).toEqual(stats);
  });

  it("无标签时返回空数组", () => {
    expect(visibleOutcomeStats(undefined, detail)).toEqual([]);
    expect(visibleOutcomeStats([], detail)).toEqual([]);
  });
});
