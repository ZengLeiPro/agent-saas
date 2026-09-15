import { describe, expect, it } from 'vitest';
import { resolveArtifactRightSlotKind, shouldOpenArtifactInRightSlot } from './artifactRightSlot';

describe('artifactRightSlot', () => {
  it('maps viewers to pane kinds without inventing HTML', () => {
    expect(resolveArtifactRightSlotKind('native-text')).toBe('text');
    expect(resolveArtifactRightSlotKind('native-image')).toBe('image');
    expect(resolveArtifactRightSlotKind('native-pdf')).toBe('system-open');
    expect(resolveArtifactRightSlotKind('native-audio')).toBe('system-open');
    expect(resolveArtifactRightSlotKind('native-video')).toBe('system-open');
    expect(resolveArtifactRightSlotKind('download-only')).toBe('download-notice');
  });

  it('only opens the right slot on md+', () => {
    expect(shouldOpenArtifactInRightSlot(true)).toBe(true);
    expect(shouldOpenArtifactInRightSlot(false)).toBe(false);
  });
});
