/**
 * md+ chat right-slot decisions for Artifact cards.
 *
 * Mobile never embeds an HTML/WebView engine (M50-03): `html` viewKind maps to
 * `download-only` via selectMobileArtifactViewer. The right slot still hosts a
 * safe pane (native text/image + download notice) so open paths match DesktopLayout.
 */
import type { MobileArtifactViewer } from './artifactViewAdapter';

export type ArtifactRightSlotKind = 'text' | 'image' | 'system-open' | 'download-notice';

/** Map mobile viewer to how ArtifactPreviewPane renders inside the right slot. */
export function resolveArtifactRightSlotKind(viewer: MobileArtifactViewer): ArtifactRightSlotKind {
  switch (viewer) {
    case 'native-text':
      return 'text';
    case 'native-image':
      return 'image';
    case 'native-pdf':
    case 'native-audio':
    case 'native-video':
      return 'system-open';
    case 'download-only':
    default:
      return 'download-notice';
  }
}

/**
 * Phone keeps download/share; md+ hosts consume into SideOverlayPanel / dock.
 * Callers pass `isMdUp` from useBreakpoint (width-driven ≥768).
 */
export function shouldOpenArtifactInRightSlot(isMdUp: boolean): boolean {
  return isMdUp;
}
