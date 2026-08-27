import type { SandboxProfile } from '@agent/shared';
import type { HandRecord, WorkspaceRecipe } from './handStore.js';

export const LEGACY_SANDBOX_PROFILE: SandboxProfile = 'coding';
export const DEFAULT_SANDBOX_PROFILE: SandboxProfile = 'daily';

const PROFILE_RESOURCES: Record<SandboxProfile, Required<Pick<NonNullable<WorkspaceRecipe['resources']>, 'cpu' | 'memoryMb'>>> = {
  daily: { cpu: '1', memoryMb: 2048 },
  coding: { cpu: '2', memoryMb: 4096 },
};

export function isSandboxProfile(value: unknown): value is SandboxProfile {
  return value === 'daily' || value === 'coding';
}

/** Existing sessions are authoritative; legacy records without the pin retain coding resources. */
export function resolveSessionSandboxProfile(input: {
  existing?: { sandboxProfile?: SandboxProfile } | null;
  requested?: unknown;
  defaultProfile?: SandboxProfile;
  forceProfile?: SandboxProfile;
}): SandboxProfile {
  if (input.forceProfile) return input.forceProfile;
  if (input.existing) {
    return isSandboxProfile(input.existing.sandboxProfile)
      ? input.existing.sandboxProfile
      : LEGACY_SANDBOX_PROFILE;
  }
  return isSandboxProfile(input.requested)
    ? input.requested
    : input.defaultProfile ?? DEFAULT_SANDBOX_PROFILE;
}

/** Profile owns CPU/memory; unrelated recipe resource limits remain intact. */
export function applySandboxProfileResources(
  recipe: Partial<WorkspaceRecipe> | undefined,
  sandboxProfile: SandboxProfile,
): Partial<WorkspaceRecipe> {
  return {
    ...(recipe ?? {}),
    resources: {
      ...(recipe?.resources ?? {}),
      ...PROFILE_RESOURCES[sandboxProfile],
    },
  };
}

export type SandboxResources = { cpu: string; memoryMb: number };

export function parseSandboxResources(value: unknown): SandboxResources | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { cpu, memoryMb } = value as { cpu?: unknown; memoryMb?: unknown };
  return typeof cpu === 'string' && cpu.trim().length > 0
    && typeof memoryMb === 'number' && Number.isSafeInteger(memoryMb) && memoryMb > 0
    ? { cpu: cpu.trim(), memoryMb }
    : undefined;
}

/** Reads the effective CPU/memory target persisted with a registered runtime hand. */
export function sandboxResourcesFromHand(
  hand: Pick<HandRecord, 'metadata'> | null | undefined,
): SandboxResources | undefined {
  const recipe = hand?.metadata?.recipe;
  return recipe && typeof recipe === 'object' && !Array.isArray(recipe)
    ? parseSandboxResources((recipe as { resources?: unknown }).resources)
    : undefined;
}

export function sandboxResourcesForSessionHand(
  hands: ReadonlyArray<Pick<HandRecord, 'handId' | 'metadata'>>,
  sessionId: string,
  executionTarget: HandRecord['type'],
): SandboxResources | undefined {
  return sandboxResourcesFromHand(hands.find(hand => hand.handId === `${sessionId}:${executionTarget}`));
}
