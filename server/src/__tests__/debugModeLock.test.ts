import { describe, expect, it } from "vitest";

import { withTenantDebugModeLock } from "../data/tenants/debugModeLock.js";

describe("withTenantDebugModeLock", () => {
  it("串行化同一组织的关闭与成员开关写入", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = withTenantDebugModeLock("tenant-a", async () => {
      order.push("first:start");
      await firstReady;
      order.push("first:end");
    });
    await Promise.resolve();

    const second = withTenantDebugModeLock("tenant-a", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
