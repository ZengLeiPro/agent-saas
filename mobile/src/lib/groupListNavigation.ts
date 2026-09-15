/**
 * Pure group-list navigation (no router).
 * md+: keep master-detail / in-pane drill; phone: stack push to /chat/group/:key.
 */
export type GroupListNavTarget = {
  groupKey: string;
  name: string;
};

export type GroupListNavDecision =
  | { kind: 'push'; href: string; groupKey: string; name: string }
  | { kind: 'pane'; groupKey: string; name: string };

/** Phone stack href for a session group (query carries display name). */
export function buildGroupPushHref(groupKey: string, name: string): string {
  const key = encodeURIComponent(groupKey);
  const q = name ? `?name=${encodeURIComponent(name)}` : '';
  return `/(tabs)/chat/group/${key}${q}`;
}

/**
 * Decide whether opening a group should stack-push (phone) or stay in-pane (md+).
 * Callers own the actual router.push / setState.
 */
export function resolveGroupListNavigation(opts: {
  isMdUp: boolean;
  groupKey: string;
  name: string;
}): GroupListNavDecision {
  const groupKey = opts.groupKey;
  const name = opts.name;
  if (opts.isMdUp) {
    return { kind: 'pane', groupKey, name };
  }
  return {
    kind: 'push',
    href: buildGroupPushHref(groupKey, name),
    groupKey,
    name,
  };
}
