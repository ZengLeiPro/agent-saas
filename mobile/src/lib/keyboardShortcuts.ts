/**
 * Pure chat shortcut matchers (web DesktopLayout / catalog feel).
 *
 * Global HardwareKeyboard / UIKeyCommand needs a native Expo module (EAS
 * binary risk) — callers may wire these from TextInput `onKeyPress` or a
 * future Expo-safe key-command helper. Matching stays JS-only and tested.
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
