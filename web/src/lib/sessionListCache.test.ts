import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiSessionListItem } from "@/lib/sessionsApi";
import { clearSessionListCache, loadSessionListCache, saveSessionListCache } from "./sessionListCache";

const A = { userId: "a", tenantId: "ta", generation: 1 };
const B = { userId: "b", tenantId: "ta", generation: 2 };
const TB = { userId: "a", tenantId: "tb", generation: 3 };
const NEXT = { userId: "a", tenantId: "ta", generation: 4 };
const makeSession = (id: string) => ({ sessionId: id, title: id, updatedAtMs: 1 }) as unknown as ApiSessionListItem;

describe("web session cache M20-04 boundary", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("isolates A -> logout -> B, tenant switch and next generation", () => {
    saveSessionListCache([makeSession("secret-a")], false, A);
    expect(loadSessionListCache(A)?.sessions[0]?.sessionId).toBe("secret-a");
    expect(loadSessionListCache(B)).toBeNull();
    expect(loadSessionListCache(TB)).toBeNull();
    expect(loadSessionListCache(NEXT)).toBeNull();
  });

  it("fails closed and deletes ownerless N-1 cache", () => {
    localStorage.setItem("sessionList:default", JSON.stringify({ sessions: [makeSession("legacy")], hasMore: false }));
    expect(loadSessionListCache(A)).toBeNull();
    expect(localStorage.getItem("sessionList:default")).toBeNull();
  });

  it("does not persist or load without authenticated identity", () => {
    saveSessionListCache([makeSession("x")], false, null);
    expect(loadSessionListCache(null)).toBeNull();
  });

  it("clear removes all scoped generations", () => {
    saveSessionListCache([makeSession("a")], false, A);
    saveSessionListCache([makeSession("b")], false, B);
    clearSessionListCache();
    expect(loadSessionListCache(A)).toBeNull();
    expect(loadSessionListCache(B)).toBeNull();
  });

  it("storage quota failure is contained", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveSessionListCache([makeSession("a")], false, A)).not.toThrow();
  });
});
