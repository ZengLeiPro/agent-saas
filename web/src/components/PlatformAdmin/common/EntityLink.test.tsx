/**
 * EntityLink 的行为契约。
 *
 * 本次只改两处（focus-visible 与 workspace kind），但这个组件承载着三条
 * 「不得弄丢的优势」，改动它必须同时锁住这三条：
 *  1. 空值统一渲染 `—`（不是空白）；
 *  2. 真 `<a href>` + 修饰键放行 → 新窗口打开可用；
 *  3. hover 出复制按钮（比对标产品普及，它只在详情头部有）。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntityLink } from "./EntityLink";

describe("EntityLink · 既有优势不能丢", () => {
  it("id 为空时渲染「—」而不是空白单元格", () => {
    const { container } = render(<EntityLink kind="run" id={null} />);
    expect(container.textContent).toBe("—");
  });

  it("id 为空串时同样渲染「—」", () => {
    const { container } = render(<EntityLink kind="user" id="" />);
    expect(container.textContent).toBe("—");
  });

  it("渲染真 <a href>，新窗口打开可用", () => {
    render(<EntityLink kind="run" id="run-123" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/platform-admin/runs/run-123");
  });

  it("长 ID 中间省略，完整 ID 进 title 便于核对", () => {
    render(<EntityLink kind="session" id="abcdefghijklmnopqrstuvwxyz" short={4} />);
    expect(screen.getByRole("link").textContent).toBe("abcd…wxyz");
    expect(screen.getByTitle("abcdefghijklmnopqrstuvwxyz")).toBeTruthy();
  });

  it("plain 模式（租户上下文）不渲染 platform-admin 跳转链接，但保留复制按钮", () => {
    render(<EntityLink kind="user" id="u-1" plain />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "复制 u-1" })).toBeTruthy();
  });
});

describe("EntityLink · 复制按钮键盘可达（本次修复）", () => {
  it("复制按钮同时挂 focus-visible 与 group-focus-within，键盘用户能拿到", () => {
    render(<EntityLink kind="run" id="run-1" />);
    const cls = screen.getByRole("button", { name: "复制 run-1" }).getAttribute("class") ?? "";
    // 改造前只有 group-hover:opacity-100，键盘 focus 永远不显形
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("focus-visible:opacity-100");
    expect(cls).toContain("group-focus-within:opacity-100");
  });
});

describe("EntityLink · workspace kind（本次新增）", () => {
  it("workspace 落到执行环境列表并预置 workspaceId 筛选（它没有独立详情页）", () => {
    render(<EntityLink kind="workspace" id="ws-abc" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/platform-admin/sandboxes?workspaceId=ws-abc");
  });

  it("sandbox 仍走 entityId 路径，两种形态不能混", () => {
    render(<EntityLink kind="sandbox" id="sbx-1" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/platform-admin/sandboxes/sbx-1");
  });

  it("workspace 的 id 需要 URL 编码", () => {
    render(<EntityLink kind="workspace" id="ws/a b" />);
    expect(screen.getByRole("link").getAttribute("href")).toContain("workspaceId=ws%2Fa+b");
  });

  it("五种既有 kind 的路径不受本次改动影响", () => {
    const cases: Array<[Parameters<typeof EntityLink>[0]["kind"], string]> = [
      ["tenant", "/platform-admin/tenants/x"],
      ["user", "/platform-admin/users/x"],
      ["session", "/platform-admin/sessions/x"],
      ["run", "/platform-admin/runs/x"],
      ["sandbox", "/platform-admin/sandboxes/x"],
    ];
    for (const [kind, href] of cases) {
      const { unmount } = render(<EntityLink kind={kind} id="x" />);
      expect(screen.getByRole("link").getAttribute("href")).toBe(href);
      unmount();
    }
  });
});
