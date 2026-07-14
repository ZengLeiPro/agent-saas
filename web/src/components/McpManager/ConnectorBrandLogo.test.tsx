import { describe, expect, it } from "vitest";
import type { McpServerSummary } from "@agent/shared";
import githubIcon from "@/assets/connector-brands/github.svg";
import gmailIcon from "@/assets/connector-brands/gmail.png";
import googleCalendarIcon from "@/assets/connector-brands/google-calendar.png";
import googleChatIcon from "@/assets/connector-brands/google-chat.png";
import googleContactsIcon from "@/assets/connector-brands/google-contacts.png";
import googleDriveIcon from "@/assets/connector-brands/google-drive.png";
import notionIcon from "@/assets/connector-brands/notion.svg";
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
    ["github", githubIcon],
    ["notion", notionIcon],
    ["google_gmail", gmailIcon],
    ["google_drive", googleDriveIcon],
    ["google_calendar", googleCalendarIcon],
    ["google_chat", googleChatIcon],
    ["google_people", googleContactsIcon],
  ])("按模板标识映射 %s", (createdFromTemplateId, expected) => {
    expect(connectorBrandIcon(server({ createdFromTemplateId }))).toBe(expected);
  });

  it("可以从自定义连接器 URL 识别平台", () => {
    expect(connectorBrandIcon(server({ config: { url: "https://mcp.notion.com/mcp" } }))).toBe(notionIcon);
  });

  it("未知平台回退到通用图标", () => {
    expect(connectorBrandIcon(server({ id: "internal_erp", name: "内部 ERP" }))).toBeNull();
  });
});
