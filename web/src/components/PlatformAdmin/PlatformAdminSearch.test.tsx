/**
 * 全局搜索的键盘动线测试。
 *
 * 为什么值得单测：`/` 是全站唯一的全局快捷键。改造前只有 Enter/Escape，
 * 用户用 `/` 聚焦后必须切回鼠标才能点结果——键盘动线是断的。
 * 这里锁住「聚焦 → 搜索 → ↑↓ 选 → Enter 打开」全程不碰鼠标。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformAdminSearch } from "./PlatformAdminSearch";

const navigateToHref = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());

vi.mock("@/lib/urlSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/urlSync")>()),
  navigateToHref,
}));

vi.mock("./api", () => ({ platformAdminApi: { search } }));

const MATCHES = [
  { kind: "tenant", id: "t1", title: "开沿科技", subtitle: undefined, href: "/platform-admin/tenants/t1" },
  { kind: "user", id: "u1", title: "曾磊", subtitle: "admin", href: "/platform-admin/users/u1" },
  { kind: "session", id: "s1", title: "报价单核对", subtitle: undefined, href: "/platform-admin/sessions/s1" },
];

async function searchAndOpenResults() {
  const user = userEvent.setup();
  render(<PlatformAdminSearch />);
  const input = screen.getByPlaceholderText(/搜索组织、用户、对话/);
  await user.click(input);
  await user.type(input, "开沿");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
  return { user, input };
}

describe("PlatformAdminSearch 键盘动线", () => {
  beforeEach(() => {
    search.mockResolvedValue({ matches: MATCHES });
    navigateToHref.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("`/` 聚焦搜索框，且在输入框内按 `/` 不会被劫持", async () => {
    const user = userEvent.setup();
    render(<PlatformAdminSearch />);
    const input = screen.getByPlaceholderText(/搜索组织、用户、对话/);

    await user.keyboard("/");
    expect(document.activeElement).toBe(input);

    // 已在输入框内时，`/` 应当作为普通字符输入
    await user.type(input, "a/b");
    expect((input as HTMLInputElement).value).toContain("/");
  });

  it("↓ 从无高亮开始逐条下移", async () => {
    const { user } = await searchAndOpenResults();
    const options = screen.getAllByRole("option");

    expect(options.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);

    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });

  it("两端循环：到底回顶、到顶回底", async () => {
    const { user } = await searchAndOpenResults();

    // ↑ 从无高亮直接到最后一条
    await user.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");

    // 再 ↓ 回到第一条
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("有高亮时 Enter 打开该条结果，而不是重新搜索", async () => {
    const { user } = await searchAndOpenResults();
    search.mockClear();

    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(navigateToHref).toHaveBeenCalledWith("/platform-admin/users/u1");
    expect(search).not.toHaveBeenCalled();
  });

  it("无高亮时 Enter 仍走重新搜索", async () => {
    const { user } = await searchAndOpenResults();
    search.mockClear();

    await user.keyboard("{Enter}");

    expect(search).toHaveBeenCalled();
    expect(navigateToHref).not.toHaveBeenCalled();
  });

  it("改动搜索词后旧高亮失效，Enter 回到重新搜索", async () => {
    const { user, input } = await searchAndOpenResults();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

    await user.type(input, "科技");
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);

    search.mockClear();
    await user.keyboard("{Enter}");
    expect(search).toHaveBeenCalled();
    expect(navigateToHref).not.toHaveBeenCalled();
  });

  it("Escape 关闭结果并清除高亮", async () => {
    const { user } = await searchAndOpenResults();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("option")).toBeNull();
  });

  it("结果未展开时方向键不劫持光标", async () => {
    const user = userEvent.setup();
    render(<PlatformAdminSearch />);
    const input = screen.getByPlaceholderText(/搜索组织、用户、对话/);

    await user.click(input);
    await user.type(input, "abc");
    await user.keyboard("{ArrowUp}");

    // 没有结果列表，不应抛错也不应产生 option
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("鼠标悬停会同步键盘高亮，避免两套高亮同时亮", async () => {
    const { user } = await searchAndOpenResults();
    await user.keyboard("{ArrowDown}");

    await user.hover(screen.getAllByRole("option")[2]);

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
  });

  it("combobox 语义完整：aria-expanded 与 aria-activedescendant 随状态变化", async () => {
    const { user } = await searchAndOpenResults();
    const input = screen.getByRole("combobox");

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe("platform-admin-search-result-0");
  });
});
