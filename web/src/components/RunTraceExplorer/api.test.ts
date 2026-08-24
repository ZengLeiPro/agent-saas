import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { runTraceApi } from "./api";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("runTraceApi.efficiency", () => {
  it("serializes the explicit ISO [from,to) window", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response);

    await runTraceApi.efficiency({
      days: 7,
      tenantId: "tenant-a",
      from: "2026-08-17T16:00:00.000Z",
      to: "2026-08-24T16:00:00.000Z",
    });

    expect(authFetch).toHaveBeenCalledWith(
      "/api/admin/runtime/trace/efficiency?days=7&tenantId=tenant-a"
      + "&from=2026-08-17T16%3A00%3A00.000Z&to=2026-08-24T16%3A00%3A00.000Z",
    );
  });
});
