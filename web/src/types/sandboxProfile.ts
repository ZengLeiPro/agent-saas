import type { SandboxProfile } from "@agent/shared";

export type { SandboxProfile };

export function resolveSessionSandboxProfile(value: unknown): SandboxProfile {
  return value === "daily" ? "daily" : "coding";
}
