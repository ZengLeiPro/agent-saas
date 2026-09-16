import { describe, expect, it } from 'vitest';
import { isSettingsPaneSection, SETTINGS_PANE_SECTION_IDS } from './settingsPaneSections';

describe('settingsPaneSections', () => {
  it('covers route sections but not trash / unavailable', () => {
    expect(SETTINGS_PANE_SECTION_IDS).toContain('account-security');
    expect(SETTINGS_PANE_SECTION_IDS).toContain('appearance-layout');
    expect(isSettingsPaneSection('account-security')).toBe(true);
    expect(isSettingsPaneSection('trash')).toBe(false);
    expect(isSettingsPaneSection('session-organization')).toBe(false);
  });
});
