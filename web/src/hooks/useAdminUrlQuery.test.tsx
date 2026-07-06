import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";

describe("useAdminUrlQuery", () => {
  it("updates search params without changing the current pathname", () => {
    window.history.replaceState({}, "", "/platform-admin/runs?status=failed");

    const { result } = renderHook(() => useAdminUrlQuery());

    expect(result.current.get("status")).toBe("failed");

    act(() => {
      result.current.set("cursor", "next-1");
    });

    expect(window.location.pathname).toBe("/platform-admin/runs");
    expect(result.current.get("status")).toBe("failed");
    expect(result.current.get("cursor")).toBe("next-1");

    act(() => {
      result.current.patch({ status: "running", cursor: null });
    });

    expect(window.location.pathname).toBe("/platform-admin/runs");
    expect(result.current.get("status")).toBe("running");
    expect(result.current.get("cursor")).toBeNull();
  });

  it("reacts to browser history navigation", () => {
    window.history.replaceState({}, "", "/platform-admin/sessions?q=first");
    const { result } = renderHook(() => useAdminUrlQuery());

    window.history.pushState({}, "", "/platform-admin/sessions?q=second");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current.get("q")).toBe("second");
  });
});
