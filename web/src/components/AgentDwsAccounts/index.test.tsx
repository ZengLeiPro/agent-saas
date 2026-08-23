import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentDwsAccount, AgentDwsAuthSession } from "@agent/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import AgentDwsAccountsPage from "./index";

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

const account: AgentDwsAccount = {
  accountId: "adws-1",
  tenantId: "tenant-a",
  agentId: "agent-sales",
  displayName: "销售成员账号",
  loginIdMasked: "sa***01",
  corpId: null,
  corpName: null,
  dingtalkUserId: null,
  dingtalkUserName: null,
  profileId: null,
  status: "draft",
  runtimeStatus: "stopped",
  eventKinds: ["at_me", "all_direct"],
  contextPolicy: {
    historical: { mode: "none", conversationIds: [], lookbackDays: 30 },
    realtime: { mode: "none", conversationIds: [] },
    wiki: { enabled: false },
    minutes: { enabled: false, lookbackDays: 30 },
  },
  lastEventAt: null,
  lastError: null,
  revision: 1,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

const awaitingSession: AgentDwsAuthSession = {
  sessionId: "auth-1",
  status: "awaiting_user",
  authorizationUrl: "https://login.dingtalk.example/device",
  userCode: "ABCD-EFGH",
  expiresAt: "2099-08-13T00:10:00.000Z",
  message: "请用 Agent 专属钉钉账号确认授权",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AgentDwsAccountsPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (path === "/api/agent-dws-accounts?tenantId=tenant-a") {
        return jsonResponse({ accounts: [account] });
      }
      if (path === "/api/org-agents?tenantId=tenant-a") {
        return jsonResponse([{ id: "agent-sales", name: "销售助手" }]);
      }
      if (path === "/api/agent-dws-accounts/adws-1/authorize?tenantId=tenant-a" && init?.method === "POST") {
        return jsonResponse({
          account: { ...account, status: "authorizing", revision: 2 },
          session: awaitingSession,
        }, 202);
      }
      if (path === "/api/agent-dws-accounts/adws-1/context-policy?tenantId=tenant-a" && init?.method === "PATCH") {
        return jsonResponse({ account: { ...account, revision: 2 } });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });
  });

  it("配置历史学习与实时监听时提交 fail-closed 范围和 CAS revision", async () => {
    const user = userEvent.setup();
    render(<AgentDwsAccountsPage tenantId="tenant-a" />);

    await screen.findByText("销售助手");
    expect(screen.getByText("历史：不采集")).toBeTruthy();
    expect(screen.getByText("实时：不监听")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "配置 Context" }));
    expect(await screen.findByRole("heading", { name: "配置 Context 范围" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保存范围" }));

    expect(await screen.findByText("Context 范围已更新")).toBeTruthy();
    const updateCall = vi.mocked(authFetch).mock.calls.find((call) => String(call[0]).includes("/context-policy?"));
    expect(updateCall?.[0]).toBe("/api/agent-dws-accounts/adws-1/context-policy?tenantId=tenant-a");
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
      expectedRevision: 1,
      historical: { mode: "none", conversationIds: [], lookbackDays: 30 },
      realtime: { mode: "none", conversationIds: [] },
      wiki: { enabled: false },
      minutes: { enabled: false, lookbackDays: 30 },
    });
  });

  it("展示真实账号状态，并用 tenant/revision 发起 OAuth、提供授权链接", async () => {
    const user = userEvent.setup();
    render(<AgentDwsAccountsPage tenantId="tenant-a" />);

    expect(await screen.findByText("这是独立成员账号，不是机器人")).toBeTruthy();
    expect(await screen.findByText("销售助手")).toBeTruthy();
    expect(screen.getByText("sa***01")).toBeTruthy();
    expect(screen.getByText("@我的消息、全部单聊")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "发起 OAuth" }));

    expect((await screen.findAllByText("请用 Agent 专属钉钉账号确认授权")).length).toBeGreaterThan(0);
    const authorizationLink = await screen.findByRole("link", { name: /打开授权页面/ });
    expect(authorizationLink.getAttribute("href")).toBe(awaitingSession.authorizationUrl);
    const authorizeCall = vi.mocked(authFetch).mock.calls.find((call) => String(call[0]).includes("/authorize?"));
    expect(authorizeCall?.[0]).toBe("/api/agent-dws-accounts/adws-1/authorize?tenantId=tenant-a");
    expect(JSON.parse(String(authorizeCall?.[1]?.body))).toEqual({ expectedRevision: 1 });
  });
});
