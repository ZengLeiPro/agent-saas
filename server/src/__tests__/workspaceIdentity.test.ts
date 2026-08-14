import { describe, expect, it } from "vitest";

import {
  deriveAgentConnectorWorkspaceId,
  deriveAgentWorkspaceId,
  deriveStableWorkspaceId,
  parseWorkspaceId,
} from "../runtime/workspaceIdentity.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import { resolveAgentConnectorCwd, resolveAgentCwd, resolveUserCwd } from "../workspace/resolver.js";

describe("deriveStableWorkspaceId", () => {
  it("derives a stable tenant/user workspace id", () => {
    expect(deriveStableWorkspaceId(
      { id: "ky8fd3xq7z2m9p", tenantId: "wain-test" },
      "session-1",
    )).toBe("ws_wain-test__ky8fd3xq7z2m9p");
  });

  it("falls back to the session workspace when there is no user id", () => {
    expect(deriveStableWorkspaceId(undefined, "session-1")).toBe("session-1");
    expect(deriveStableWorkspaceId({ tenantId: "wain-test" }, "session-2")).toBe("session-2");
  });

  it("falls back to platform root for invalid tenant slugs", () => {
    expect(deriveStableWorkspaceId(
      { id: "ky8fd3xq7z2m9p", tenantId: "../wain" },
      "session-1",
    )).toBe(`ws_${DEFAULT_TENANT_ID}__ky8fd3xq7z2m9p`);
  });

  it("hashes unsafe legacy user ids into a path-safe segment", () => {
    expect(deriveStableWorkspaceId(
      { id: "../legacy/user", tenantId: "kaiyan" },
      "session-1",
    )).toMatch(/^ws_kaiyan__h[A-Za-z0-9_-]{16}$/);
  });
});

describe("deriveAgentWorkspaceId", () => {
  it("uses an explicit agent namespace", () => {
    expect(deriveAgentWorkspaceId("kaiyan", "oa-sales")).toBe("ws_kaiyan__agent_oa-sales");
    expect(deriveAgentWorkspaceId("../bad", "../legacy-agent")).toMatch(
      new RegExp(`^ws_${DEFAULT_TENANT_ID}__agent_h[A-Za-z0-9_-]{16}$`),
    );
  });

  it("does not parse Agent or connector workspaces as real users", () => {
    expect(parseWorkspaceId(deriveAgentWorkspaceId("kaiyan", "oa-sales"))).toBeNull();
    expect(parseWorkspaceId(deriveAgentConnectorWorkspaceId("kaiyan", "oa-sales", "dws"))).toBeNull();
  });

  it("separates model, connector, and real-user physical directory trees", () => {
    expect(resolveAgentCwd("/workspaces", "kaiyan", "oa-sales")).toBe("/workspaces/kaiyan/.agent-oa-sales");
    expect(resolveAgentConnectorCwd("/workspaces", "kaiyan", "oa-sales", "dws")).toBe(
      "/workspaces/kaiyan/.agent-connectors-oa-sales/dws",
    );
    expect(resolveAgentConnectorCwd("/workspaces", "kaiyan", "oa-sales", "dws")).not.toBe(
      resolveAgentCwd("/workspaces", "kaiyan", "oa-sales"),
    );
    expect(resolveAgentCwd("/workspaces", "kaiyan", "same-id")).not.toBe(
      resolveUserCwd("/workspaces", { id: "same-id", username: "same", role: "user", tenantId: "kaiyan" }),
    );
  });
});

describe("parseWorkspaceId", () => {
  it("parses standard tenant/user workspace ids", () => {
    expect(parseWorkspaceId("ws_kaiyan__ky8fd3xq7z2m9p")).toEqual({
      tenantId: "kaiyan",
      userId: "ky8fd3xq7z2m9p",
    });
  });

  it("ignores mountSubPath suffix on sandbox scope ids", () => {
    expect(parseWorkspaceId("ws_pantheon__kyadmin123__workspaces_pantheon_kyadmin123")).toEqual({
      tenantId: "pantheon",
      userId: "kyadmin123",
    });
  });

  it("parses hashed user id segments", () => {
    expect(parseWorkspaceId("ws_kaiyan__hAbc_123-XYZ9876")).toEqual({
      tenantId: "kaiyan",
      userId: "hAbc_123-XYZ9876",
    });
  });

  it("returns null for non-user workspace ids", () => {
    expect(parseWorkspaceId("f5b6d6f6-7b8a-4b1e-a9d8-111111111111")).toBeNull();
    expect(parseWorkspaceId("network-probe-abc")).toBeNull();
    expect(parseWorkspaceId("as-ws-ci-abcdef")).toBeNull();
    expect(parseWorkspaceId("ws_../bad__user")).toBeNull();
  });
});
