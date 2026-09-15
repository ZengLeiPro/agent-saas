/**
 * Pure chat shortcut matchers (web DesktopLayout / catalog feel).
 *
 * ## Expo-safe wiring status (P5)
 * No safe global key-command path without a new native module:
 * - RN `TextInput` `onKeyPress` only exposes `{ key }` — no `metaKey` / `ctrlKey`
 *   on iOS/Android (see `TextInputKeyPressEventData`).
 * - `react-native-keyboard-controller` covers keyboard geometry only, not
 *   hardware key commands.
 * - RN's internal `RCTKeyCommands` is not a public JS API for app shortcuts;
 *   wiring ⌘/Ctrl+N via UIKeyCommand would need a custom Expo native module
 *   (EAS binary risk) — deferred with P4.
 *
 * Keep matchers JS-only and tested. Call sites may later wire from a sanctioned
 * Expo module or RN-web where modifier flags exist; do not invent a polyfill.
 */
export type ChatShortcutAction = 'new-chat' | 'focus-composer' | 'search';

export type KeyShortcutEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

function hasPrimaryModifier(event: KeyShortcutEvent): boolean {
  return !!(event.metaKey || event.ctrlKey);
}

/**
 * Match desktop-ish chat shortcuts:
 * - ⌘/Ctrl+N → new chat
 * - ⌘/Ctrl+/ → focus composer
 * - ⌘/Ctrl+K → search (session filter / catalog)
 */
export function matchChatShortcut(event: KeyShortcutEvent): ChatShortcutAction | null {
  if (event.altKey) return null;
  if (!hasPrimaryModifier(event)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'n' && !event.shiftKey) return 'new-chat';
  if (key === '/' && !event.shiftKey) return 'focus-composer';
  if (key === 'k' && !event.shiftKey) return 'search';
  return null;
}

/** Always false on current Expo RN — see file header. Useful for call-site guards. */
export function canWireChatShortcutsExpoSafe(): boolean {
  return false;
}
