import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { useTenantRemoteHands } from "./hooks";
import type { TenantRemoteHandsConfig } from "./types";

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/refreshBus", () => ({
  registerRefresh: vi.fn(),
  unregisterRefresh: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function config(id: string): TenantRemoteHandsConfig {
  return { hands: [{ id, baseUrl: `https://${id}.example.com` }] };
}

function response(tenantRemoteHands: TenantRemoteHandsConfig): Response {
  return new Response(JSON.stringify({
    tenantRemoteHands,
    revision: "revision-hands-1",
    writePolicy: { environment: "development", mode: "online", canSave: true },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("useTenantRemoteHands request ordering", () => {
  it("在版本 GET 完成前拒绝保存，加载后保存结果不会被旧请求覆盖", async () => {
    const pendingGet = deferred<Response>();
    const saved = config("saved");
    vi.mocked(authFetch)
      .mockReturnValueOnce(pendingGet.promise)
      .mockResolvedValueOnce(response(saved));

    const { result } = renderHook(() => useTenantRemoteHands());
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      await expect(result.current.save(saved.hands)).rejects.toThrow("配置版本尚未加载");
    });
    expect(authFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingGet.resolve(response(config("initial")));
      await pendingGet.promise;
    });
    await waitFor(() => expect(result.current.readOnly).toBe(false));
    await act(async () => {
      await result.current.save(saved.hands);
    });
    expect(result.current.config).toEqual(saved);
    expect(result.current.savedAt).not.toBeNull();
  });

  it("ignores a late GET and further refreshes after the editor becomes dirty", async () => {
    const pendingGet = deferred<Response>();
    vi.mocked(authFetch).mockReturnValueOnce(pendingGet.promise);

    const { result, rerender } = renderHook(
      ({ blocked }) => useTenantRemoteHands(blocked),
      { initialProps: { blocked: false } },
    );
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    rerender({ blocked: true });

    await act(async () => {
      pendingGet.resolve(response(config("stale")));
      await pendingGet.promise;
    });
    expect(result.current.config).toBeNull();
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores refresh while a save is in flight", async () => {
    const initial = config("initial");
    const saved = config("saved");
    const pendingPut = deferred<Response>();
    vi.mocked(authFetch)
      .mockResolvedValueOnce(response(initial))
      .mockReturnValueOnce(pendingPut.promise);

    const { result } = renderHook(() => useTenantRemoteHands());
    await waitFor(() => expect(result.current.config).toEqual(initial));

    let savePromise!: Promise<TenantRemoteHandsConfig>;
    act(() => {
      savePromise = result.current.save(saved.hands);
    });
    await waitFor(() => expect(result.current.saving).toBe(true));

    await act(async () => {
      await result.current.refresh();
    });
    expect(authFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingPut.resolve(response(saved));
      await savePromise;
    });
    expect(result.current.config).toEqual(saved);
  });
});
