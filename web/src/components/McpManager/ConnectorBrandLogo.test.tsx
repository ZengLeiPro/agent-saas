import { describe, expect, it } from "vitest";
import type { McpServerSummary } from "@agent/shared";
import { connectorBrandIcon } from "./ConnectorBrandLogo";

function server(overrides: Partial<McpServerSummary>): McpServerSummary {
  return {
    id: "custom",
    name: "自定义连接器",
    enabledByDefault: false,
    enabled: false,
    transport: "streamable-http",
    ...overrides,
  };
}

describe("connectorBrandIcon", () => {
  it.each([
    ["github", "github.svg"],
    ["notion", "notion.svg"],
    ["google_gmail", "gmail.png"],
    ["google_drive", "google-drive.png"],
    ["google_calendar", "google-calendar.png"],
    ["google_chat", "google-chat.png"],
    ["google_people", "google-contacts.png"],
  ])("按模板标识映射 %s", (createdFromTemplateId, expected) => {
    expect(connectorBrandIcon(server({ createdFromTemplateId }))).toBe(expected);
  });

  it("可以从自定义连接器 URL 识别平台", () => {
    expect(connectorBrandIcon(server({ config: { url: "https://mcp.notion.com/mcp" } }))).toBe("notion.svg");
  });

  it("未知平台回退到通用图标", () => {
    expect(connectorBrandIcon(server({ id: "internal_erp", name: "内部 ERP" }))).toBeNull();
  });
});
