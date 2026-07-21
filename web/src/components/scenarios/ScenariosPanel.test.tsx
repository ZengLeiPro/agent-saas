/**
 * ScenariosPanel · e2e-ish 集成测试
 *
 * 覆盖 industry chip 的三源合流（URL / localStorage / preferences.industryHint）、URL 同步、
 * localStorage 记忆、空态 fallback、industry × role AND 双重过滤、以及 "industryFocus undefined
 * = 全行业通用" 的核心语义。
 *
 * 走真实的 useIndustryFilter + useAdminUrlQuery，不 mock 内部 URL 逻辑；只 mock:
 *   - useScenarioLibrary（本地假数据，避免 fetch）
 *   - AuthContext（控制 preferences.industryHint）
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioItem, ScenarioLibraryResponse } from "@agent/shared";

import { ScenariosPanel } from "./ScenariosPanel";

const mocked = vi.hoisted(() => ({
  library: null as ScenarioLibraryResponse | null,
  fallbackReason: null as string | null,
  user: null as {
    position?: string | null;
    preferences?: { activeRoleId?: string; industryHint?: string };
  } | null,
}));

vi.mock("./useScenarioLibrary", async () => {
  const actual = await vi.importActual<typeof import("./useScenarioLibrary")>(
    "./useScenarioLibrary",
  );
  return {
    ...actual,
    useScenarioLibrary: () => ({
      library: mocked.library,
      workflowLibrary: null,
      mode: mocked.fallbackReason ? "legacy-fallback" : "legacy",
      fallbackReason: mocked.fallbackReason,
      loading: false,
      error: null,
      reload: vi.fn(),
    }),
  };
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mocked.user }),
}));

// RoleKitDetailPage 内部会用 useIndustryFilter（同一 hook），
// 但本组件只在传入 roleDetailId 时才渲染它，测试里不触发这条路径。

const STORAGE_KEY = "ky.scenarios.industry";

const scenarioBase: Omit<ScenarioItem, "id" | "title" | "role" | "industryFocus"> = {
  industries: ["manufacturing"],
  mode: "oneshot",
  pitch: "一句话卖点",
  story: "步骤 A → 步骤 B",
  promptTemplate: "帮我处理 {{target}}",
  slots: [{ key: "target", label: "对象", example: "示例对象" }],
  requires: ["web"],
  recommendCron: false,
};

function makeScenario(
  id: string,
  role: string,
  industryFocus: ScenarioItem["industryFocus"],
  title = id,
): ScenarioItem {
  return { ...scenarioBase, id, role, title, industryFocus };
}

// 3 岗位 × 4 场景，涵盖：
//   universal-boss  → role=boss, industryFocus=undefined（全行业通用，防回归关键条目）
//   retail-boss     → role=boss, industryFocus=["retail"]
//   retail-sales    → role=sales, industryFocus=["retail","ecommerce"]
//   manuf-sales     → role=sales, industryFocus=["manufacturing"]
function buildLibrary(): ScenarioLibraryResponse {
  return {
    roles: [
      { id: "boss", name: "老板/总经理", sort: 1 },
      { id: "sales", name: "销售", sort: 2 },
    ],
    scenarios: [
      makeScenario("universal-boss", "boss", undefined, "老板 · 通用竞品晨报"),
      makeScenario("retail-boss", "boss", ["retail"], "老板 · 零售门店日报"),
      makeScenario("retail-sales", "sales", ["retail", "ecommerce"], "销售 · 零售电商客户简报"),
      makeScenario("manuf-sales", "sales", ["manufacturing"], "销售 · 制造业客户简报"),
    ],
  };
}

function resetHistory() {
  window.history.replaceState({}, "", "/");
}

beforeEach(() => {
  mocked.library = buildLibrary();
  // 默认 user：无 preferences.industryHint，无 activeRoleId，避免自动触发 role tab
  mocked.user = { position: null, preferences: {} };
  localStorage.clear();
  resetHistory();
});

afterEach(() => {
  localStorage.clear();
  resetHistory();
  mocked.library = null;
  mocked.fallbackReason = null;
  mocked.user = null;
});

function renderPanel() {
  return render(<ScenariosPanel onTryScenario={vi.fn()} />);
}

function visibleTitles(): string[] {
  return mocked
    .library!.scenarios.map((s) => s.title)
    .filter((title) => screen.queryByText(title) !== null);
}

describe("ScenariosPanel · industry chip 集成", () => {
  it("兼容回退只显示客户安全文案，不暴露校验或内部错误", () => {
    mocked.fallbackReason = "schema validation failed: upstream response invalid";
    renderPanel();
    expect(screen.getByRole("status").textContent).toBe("当前显示兼容目录。Agent 开小差了，请发送「继续」。");
    expect(document.body.textContent).not.toContain("schema");
    expect(document.body.textContent).not.toContain("upstream");
    expect(document.body.textContent).not.toContain("校验");
  });
  it("行业与岗位使用完全一致的筛选标签样式", () => {
    renderPanel();

    const industryTab = screen.getByRole("tab", { name: "全部行业" });
    const roleTab = screen.getByRole("tab", { name: "全部" });
    expect(industryTab.className).toBe(roleTab.className);
    expect(industryTab.className).toContain("rounded-full");
    expect(industryTab.className).toContain("bg-primary");
  });

  it("默认无 URL / storage / preferences 时全部行业 + 全部岗位：4 条全显", () => {
    renderPanel();

    // 全部行业 chip 高亮
    const allChip = screen.getByRole("tab", { name: "全部行业" });
    expect(allChip.getAttribute("aria-selected")).toBe("true");

    // 4 条场景全部渲染
    expect(visibleTitles()).toEqual([
      "老板 · 通用竞品晨报",
      "老板 · 零售门店日报",
      "销售 · 零售电商客户简报",
      "销售 · 制造业客户简报",
    ]);

    // URL 未被写入
    expect(window.location.search).toBe("");
  });

  it("点「零售」→ 卡片按 industry 收窄 + URL 同步 + localStorage 记忆", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "零售" }));

    // 收窄：零售 chip 高亮，只保留命中 retail 或未填 industryFocus 的场景
    expect(
      screen.getByRole("tab", { name: "零售" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(visibleTitles()).toEqual([
      "老板 · 通用竞品晨报", // industryFocus=undefined → 通用命中
      "老板 · 零售门店日报", // ["retail"] → 命中
      "销售 · 零售电商客户简报", // ["retail","ecommerce"] → 命中
      // "销售 · 制造业客户简报" 应被过滤掉
    ]);
    expect(screen.queryByText("销售 · 制造业客户简报")).toBeNull();

    // URL 同步：?industry=retail
    expect(window.location.search).toBe("?industry=retail");

    // localStorage 记忆
    expect(localStorage.getItem(STORAGE_KEY)).toBe("retail");
  });

  it("点「全部行业」清除 URL + localStorage（会话回到默认态）", () => {
    // 先选 retail 打底
    localStorage.setItem(STORAGE_KEY, "retail");
    window.history.replaceState({}, "", "?industry=retail");
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "全部行业" }));

    expect(window.location.search).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    // 4 条全部回来
    expect(visibleTitles()).toHaveLength(4);
  });

  it("industryFocus 未填 = 全行业通用（防回归 · 决策 2 语义细则）", () => {
    renderPanel();

    // 依次切到 6 个行业，"老板 · 通用竞品晨报"（industryFocus=undefined）每次都应存在
    for (const industryName of ["制造", "贸易", "零售", "服务", "出口", "电商"]) {
      fireEvent.click(screen.getByRole("tab", { name: industryName }));
      expect(screen.getByText("老板 · 通用竞品晨报")).toBeTruthy();
    }
  });

  it("三源合流优先级 URL > localStorage > preferences.industryHint", () => {
    // URL: ecommerce（分享链接场景）
    window.history.replaceState({}, "", "?industry=ecommerce");
    // localStorage: retail（熟客本地偏好）
    localStorage.setItem(STORAGE_KEY, "retail");
    // preferences: export（用户资料兜底）
    mocked.user = { position: null, preferences: { industryHint: "export" } };

    renderPanel();

    // URL 胜出，activeIndustry = ecommerce
    expect(
      screen.getByRole("tab", { name: "电商" }).getAttribute("aria-selected"),
    ).toBe("true");
    // 电商命中 retail-sales (["retail","ecommerce"]) 与 universal-boss (undefined)
    expect(visibleTitles()).toEqual([
      "老板 · 通用竞品晨报",
      "销售 · 零售电商客户简报",
    ]);
  });

  it("URL 缺失 + localStorage 有值 → 用 storage 作为初值，且反写到 URL 便于分享", () => {
    localStorage.setItem(STORAGE_KEY, "retail");
    // preferences: 有 hint 但比 storage 优先级低
    mocked.user = { position: null, preferences: { industryHint: "export" } };

    renderPanel();

    expect(
      screen.getByRole("tab", { name: "零售" }).getAttribute("aria-selected"),
    ).toBe("true");
    // 初值来自 storage 时，mount effect 应反写 URL 以支持分享
    expect(window.location.search).toBe("?industry=retail");
    // storage 未被清（初始化不动 storage）
    expect(localStorage.getItem(STORAGE_KEY)).toBe("retail");
  });

  it("URL / storage 都缺失 + preferences.industryHint 兜底默认选中", () => {
    mocked.user = { position: null, preferences: { industryHint: "export" } };

    renderPanel();

    expect(
      screen.getByRole("tab", { name: "出口" }).getAttribute("aria-selected"),
    ).toBe("true");
    // preferences 是最兜底源，也要反写 URL 以支持分享
    expect(window.location.search).toBe("?industry=export");
    // 但不应污染 localStorage（避免默认偏好写入本地）
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("undefined industryHint 走默认 all：不写 URL、不写 storage、全 4 条显示", () => {
    mocked.user = { position: null, preferences: { industryHint: undefined } };

    renderPanel();

    expect(
      screen.getByRole("tab", { name: "全部行业" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(window.location.search).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(visibleTitles()).toHaveLength(4);
  });

  it("industry × role AND 双重过滤：零售 + 销售 只留 retail-sales", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "零售" }));
    fireEvent.click(screen.getByRole("tab", { name: "销售" }));

    // 只有 role=sales 且 industryFocus 命中 retail 的条目
    // manuf-sales: role=sales 但 industryFocus=["manufacturing"] → 不命中
    // universal-boss: role=boss → 被 role filter drop
    // retail-boss: role=boss → 被 role filter drop
    expect(visibleTitles()).toEqual(["销售 · 零售电商客户简报"]);
  });

  it("空态 fallback：非法 URL industry 视为 all（不消失也不炸）", () => {
    window.history.replaceState({}, "", "?industry=not-a-real-industry");

    renderPanel();

    // 非法值 → 走 all
    expect(
      screen.getByRole("tab", { name: "全部行业" }).getAttribute("aria-selected"),
    ).toBe("true");
    // 4 条全在
    expect(visibleTitles()).toHaveLength(4);
    // 非法值不应被反写：activeIndustry=all 时 mount effect 不 set URL，
    // 原非法值仍留在 URL 里（后续用户点任意 chip 才会覆盖），但业务态是 all。
    // 这里只关心 UI/过滤正确，不断言 URL 的非法值残留。
  });

  it("空态文案：切到无匹配的行业时显示行业专属提示", () => {
    // 场景库里没有任何 service 行业的场景
    // 但 universal-boss (industryFocus=undefined) 会通用命中，所以要清掉通用条目才能进空态
    mocked.library = {
      roles: [{ id: "boss", name: "老板/总经理", sort: 1 }],
      scenarios: [makeScenario("only-manuf", "boss", ["manufacturing"], "老板 · 制造场景")],
    };

    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "服务" }));

    // 空态文案带具体行业名 + 引导「切换到全部行业」
    expect(screen.getByText(/服务行业暂无匹配任务模板/)).toBeTruthy();
    expect(screen.getByText(/试试切换到「全部行业」/)).toBeTruthy();
  });
});
