/**
 * ScopeFilters 的行为契约。
 *
 * 改造前这个筛选器有两处**静默失败**，测试的全部目的就是让它们再也回不来：
 *  1. 硬 `limit: 100`：超过 100 人的组织，第 101 个人在 UI 上根本不存在，
 *     而界面上没有任何迹象说明列表被截断了；
 *  2. `.catch(() => setUsers([]))`：接口挂了显示成「这个组织没有用户」——
 *     把「取不到」伪装成「没有」，是比缺功能更严重的问题。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserInfo } from "@/components/UserManager/types";

import { ScopeFilters } from "./ScopeFilters";

const usersMock = vi.fn();

vi.mock("../api", () => ({
  platformAdminApi: {
    users: (...args: unknown[]) => usersMock(...args),
  },
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({
    tenants: [
      { id: "t1", name: "开沿科技" },
      { id: "t2", name: "示例组织" },
    ],
  }),
}));

function user(id: string, username: string, realName?: string): UserInfo {
  return { id, username, realName, tenantId: "t1", role: "user", disabled: false } as UserInfo;
}

function page(items: UserInfo[], nextCursor?: string) {
  return { items, nextCursor };
}

beforeEach(() => {
  usersMock.mockReset();
});

describe("ScopeFilters · 组织筛选", () => {
  it("组织下拉列出全部组织并含「全部组织」", async () => {
    usersMock.mockResolvedValue(page([]));
    render(<ScopeFilters tenantId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按组织筛选"));
    await waitFor(() => expect(screen.getByRole("option", { name: "全部组织" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "开沿科技" })).toBeTruthy();
  });

  it("切换组织时把 userId 一并清空（旧用户不属于新组织）", async () => {
    usersMock.mockResolvedValue(page([]));
    const onChange = vi.fn();
    render(<ScopeFilters tenantId="" userId="" onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("按组织筛选"));
    await waitFor(() => expect(screen.getByRole("option", { name: "开沿科技" })).toBeTruthy());
    await userEvent.click(screen.getByRole("option", { name: "开沿科技" }));

    expect(onChange).toHaveBeenCalledWith({ tenantId: "t1", userId: null });
  });

  it("不传 userId 时不渲染用户筛选器", () => {
    usersMock.mockResolvedValue(page([]));
    render(<ScopeFilters tenantId="t1" onChange={() => {}} />);
    expect(screen.queryByLabelText("按用户筛选")).toBeNull();
  });
});

describe("ScopeFilters · 用户筛选不再静默失败", () => {
  it("拉取失败时给出错误 + 重试，绝不显示成「没有用户」", async () => {
    usersMock.mockRejectedValue(new Error("HTTP 500"));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByText("用户列表没能取到，这不代表该组织没有用户。")).toBeTruthy());
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    // 关键：不能出现「该组织下暂无用户」这种把失败说成空的文案
    expect(screen.queryByText("该组织下暂无用户")).toBeNull();
  });

  it("点重试会重新请求", async () => {
    usersMock.mockRejectedValueOnce(new Error("HTTP 500")).mockResolvedValue(page([user("u1", "zhang")]));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));

    await waitFor(() => expect(screen.getByRole("option", { name: /zhang/ })).toBeTruthy());
    expect(usersMock).toHaveBeenCalledTimes(2);
  });

  it("真的没有用户时才说「暂无用户」，与失败态区分", async () => {
    usersMock.mockResolvedValue(page([]));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByText("该组织下暂无用户")).toBeTruthy());
  });

  it("列表取满一页时显式标注已截断（不再静默丢掉第 51 个人）", async () => {
    usersMock.mockResolvedValue(page(Array.from({ length: 50 }, (_, i) => user(`u${i}`, `user${i}`))));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByText(/仅显示前 50 位/)).toBeTruthy());
  });

  it("后端给了 nextCursor 同样标注截断", async () => {
    usersMock.mockResolvedValue(page([user("u1", "zhang")], "cursor-2"));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByText(/仅显示前 50 位/)).toBeTruthy());
  });

  it("没截断时不显示截断提示（不制造无意义噪音）", async () => {
    usersMock.mockResolvedValue(page([user("u1", "zhang")]));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByRole("option", { name: /zhang/ })).toBeTruthy());
    expect(screen.queryByText(/仅显示前 50 位/)).toBeNull();
  });
});

describe("ScopeFilters · 用户搜索走服务端", () => {
  it("输入关键词后带 q 重新请求（不是前端过滤 100 条）", async () => {
    usersMock.mockResolvedValue(page([user("u1", "zhang", "张三")]));
    render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(usersMock).toHaveBeenCalledWith({ tenantId: "t1", q: undefined, limit: 50 }));

    await userEvent.type(screen.getByLabelText("搜索用户"), "李");
    await waitFor(() => expect(usersMock).toHaveBeenCalledWith({ tenantId: "t1", q: "李", limit: 50 }), { timeout: 2000 });
  });

  it("选中用户回调其 id，并关闭弹层", async () => {
    usersMock.mockResolvedValue(page([user("u1", "zhang", "张三")]));
    const onChange = vi.fn();
    render(<ScopeFilters tenantId="t1" userId="" onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByRole("option", { name: /张三/ })).toBeTruthy());
    await userEvent.click(screen.getByRole("option", { name: /张三/ }));

    expect(onChange).toHaveBeenCalledWith({ userId: "u1" });
    await waitFor(() => expect(screen.queryByLabelText("搜索用户")).toBeNull());
  });

  it("选「全部用户」回调 null 而不是空串", async () => {
    usersMock.mockResolvedValue(page([user("u1", "zhang")]));
    const onChange = vi.fn();
    render(<ScopeFilters tenantId="t1" userId="u1" onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await waitFor(() => expect(screen.getByRole("option", { name: "全部用户" })).toBeTruthy());
    await userEvent.click(screen.getByRole("option", { name: "全部用户" }));

    expect(onChange).toHaveBeenCalledWith({ userId: null });
  });

  it("触发器回显姓名（用户名），未选时显示「全部用户」", async () => {
    usersMock.mockResolvedValue(page([user("u1", "zhang", "张三")]));
    const { unmount } = render(<ScopeFilters tenantId="t1" userId="" onChange={() => {}} />);
    expect(screen.getByLabelText("按用户筛选").textContent).toContain("全部用户");
    unmount();

    render(<ScopeFilters tenantId="t1" userId="u1" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("按用户筛选").textContent).toContain("张三（zhang）"));
  });

  it("已选用户被搜索词过滤掉时，触发器仍显示上次拿到的名字而不是闪回裸 ID", async () => {
    usersMock.mockResolvedValueOnce(page([user("u1", "zhang", "张三")])).mockResolvedValue(page([]));
    render(<ScopeFilters tenantId="t1" userId="u1" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("按用户筛选").textContent).toContain("张三"));

    await userEvent.click(screen.getByLabelText("按用户筛选"));
    await userEvent.type(screen.getByLabelText("搜索用户"), "不存在");
    await waitFor(() => expect(screen.getByText("没有匹配的用户，换个关键词试试")).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByLabelText("按用户筛选").textContent).toContain("张三");
  });
});
