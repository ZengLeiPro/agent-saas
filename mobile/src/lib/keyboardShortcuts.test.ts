import { describe, expect, it } from 'vitest';
import { canWireChatShortcutsExpoSafe, matchChatShortcut } from './keyboardShortcuts';

describe('matchChatShortcut', () => {
  it('matches ⌘/Ctrl+N as new-chat', () => {
    expect(matchChatShortcut({ key: 'n', metaKey: true })).toBe('new-chat');
    expect(matchChatShortcut({ key: 'N', ctrlKey: true })).toBe('new-chat');
  });

  it('matches ⌘/Ctrl+/ as focus-composer', () => {
    expect(matchChatShortcut({ key: '/', metaKey: true })).toBe('focus-composer');
  });

  it('matches ⌘/Ctrl+K as search', () => {
    expect(matchChatShortcut({ key: 'k', metaKey: true })).toBe('search');
  });

  it('ignores bare keys and alt combinations', () => {
    expect(matchChatShortcut({ key: 'n' })).toBeNull();
    expect(matchChatShortcut({ key: 'n', metaKey: true, altKey: true })).toBeNull();
  });
});

describe('canWireChatShortcutsExpoSafe', () => {
  it('is false — no modifier-aware Expo-safe listener yet', () => {
    expect(canWireChatShortcutsExpoSafe()).toBe(false);
  });
});
