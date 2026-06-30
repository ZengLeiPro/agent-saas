import { describe, it, expect } from "vitest";
import { computeNextRunAtMs, validateCronExpr } from "../cron/scheduler.js";

describe("cron scheduler", () => {
  it("computes next run for kind=at", () => {
    expect(computeNextRunAtMs({ kind: "at", atMs: 2000 }, 1000)).toBe(2000);
    expect(computeNextRunAtMs({ kind: "at", atMs: 500 }, 1000)).toBeUndefined();
  });

  it("computes next run for kind=every", () => {
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 0)).toBe(1000);
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 999)).toBe(1000);
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1000, anchorMs: 0 }, 1000)).toBe(2000);
  });

  it("computes next run for kind=cron (UTC)", () => {
    const now = Date.parse("2026-01-31T01:23:00.000Z");
    const next = computeNextRunAtMs({ kind: "cron", expr: "0 0 * * *", tz: "UTC" }, now);
    expect(next).toBe(Date.parse("2026-02-01T00:00:00.000Z"));
  });

  it("validates cron expressions", () => {
    expect(validateCronExpr("0 9 * * *", "UTC").valid).toBe(true);
    expect(validateCronExpr("not a cron", "UTC").valid).toBe(false);
  });
});

