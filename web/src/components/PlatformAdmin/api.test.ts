import { describe, expect, it } from "vitest";

import { buildAdminApiPath } from "./api";

describe("platform admin api", () => {
  it("builds admin paths with encoded query params and skips empty values", () => {
    expect(buildAdminApiPath("/sessions", {
      tenantId: "kaiyan",
      userId: "",
      includeDeleted: true,
      cursor: "a+b/c",
      limit: 50,
    })).toBe("/api/admin/sessions?tenantId=kaiyan&includeDeleted=true&cursor=a%2Bb%2Fc&limit=50");
  });

  it("keeps paths query-free when all values are empty", () => {
    expect(buildAdminApiPath("/tenants/overview", {
      tenantId: "",
      cursor: null,
      q: undefined,
    })).toBe("/api/admin/tenants/overview");
  });
});
