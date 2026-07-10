import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usageApi } from "@/components/UsageDashboard/api";
import type { ByModelResp, ByUserResp, OverviewStats, TrendResp } from "@/components/UsageDashboard/types";
import { useTenantUsageBundle } from "./hooks";

vi.mock("@/components/UsageDashboard/api", () => ({
  usageApi: {
    overview: vi.fn(),
    trend: vi.fn(),
    byModel: vi.fn(),
    byUser: vi.fn(),
  },
}));

describe("useTenantUsageBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usageApi.overview).mockResolvedValue({ totalTokens: 100 } as OverviewStats);
    vi.mocked(usageApi.trend).mockResolvedValue({ points: [] } as unknown as TrendResp);
    vi.mocked(usageApi.byModel).mockResolvedValue({ models: [] } as unknown as ByModelResp);
    vi.mocked(usageApi.byUser).mockResolvedValue({ users: [] } as unknown as ByUserResp);
  });

  it("切换组织后立即清空上一组织数据", async () => {
    const { result, rerender } = renderHook(
      ({ tenantId }: { tenantId: string }) => useTenantUsageBundle(tenantId),
      { initialProps: { tenantId: "tenant-a" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overview?.totalTokens).toBe(100);

    const pending = new Promise<never>(() => undefined);
    vi.mocked(usageApi.overview).mockImplementationOnce(() => pending);
    vi.mocked(usageApi.trend).mockImplementationOnce(() => pending);
    vi.mocked(usageApi.byModel).mockImplementationOnce(() => pending);
    vi.mocked(usageApi.byUser).mockImplementationOnce(() => pending);

    rerender({ tenantId: "tenant-b" });

    expect(result.current.loading).toBe(true);
    expect(result.current.overview).toBeNull();
    expect(result.current.byModel).toBeNull();
  });
});
