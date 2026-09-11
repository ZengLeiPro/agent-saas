// Additive diagnostic projection. Missing/contradictory scope proof remains unknown.
export function safeComponentResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const scope of ['acs', 'app', 'web']) {
    const item = value[scope];
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.rollbackAttempted !== 'boolean' || typeof item.rollbackVerified !== 'boolean' ||
      !['before', 'target', 'mixed_or_unknown'].includes(item.state) ||
      (item.rollbackVerified && (!item.rollbackAttempted || item.state !== 'before'))) return null;
    result[scope] = { rollbackAttempted: item.rollbackAttempted,
      rollbackVerified: item.rollbackVerified, state: item.state };
  }
  return result;
}
