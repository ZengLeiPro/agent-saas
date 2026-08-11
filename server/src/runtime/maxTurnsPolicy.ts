interface MaxTurnsPolicyConfig {
  defaultMaxTurns?: number;
  resolveUserMaxTurns?: (identity: { userId?: string; username?: string }) => number | undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveEffectiveMaxTurns(
  config: MaxTurnsPolicyConfig,
  requested: unknown,
  identity: { userId?: string; username?: string },
): number {
  const requestedMaxTurns = normalizePositiveInt(requested);
  const defaultMaxTurns = normalizePositiveInt(config.defaultMaxTurns) ?? 20;
  const userMaxTurns = normalizePositiveInt(config.resolveUserMaxTurns?.(identity));
  return Math.min(requestedMaxTurns ?? defaultMaxTurns, userMaxTurns ?? Infinity);
}
