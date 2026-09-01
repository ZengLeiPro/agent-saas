import {
  presentationSemanticSignature,
  selectBusinessStepPresentation,
  selectErrorPresentation,
  selectPresentationCardViewModel,
  selectSharedPresentation,
  selectToolPresentation,
  selectUnknownCardViewModel,
  type BusinessStepEventItem,
  type CardViewModel,
  type RawPresentationGate,
  type RenderTimelineItem,
  type SharedPresentation,
} from '@agent/shared';

export interface MobilePresentationSurface {
  key: string;
  kind: 'tool' | 'error' | 'business_step' | 'unknown';
  presentation: SharedPresentation;
  card?: CardViewModel;
  semantic: string;
  accessibility: {
    role: 'summary' | 'alert';
    label: string;
    live: 'polite' | 'assertive';
  };
}

function surface(
  key: string,
  kind: MobilePresentationSurface['kind'],
  presentation: SharedPresentation,
  card?: CardViewModel,
): MobilePresentationSurface {
  const danger = presentation.tone === 'danger';
  return {
    key,
    kind,
    presentation,
    ...(card ? { card } : {}),
    semantic: presentationSemanticSignature(presentation),
    accessibility: {
      role: danger ? 'alert' : 'summary',
      label: [
        presentation.title,
        presentation.statusLabel,
        presentation.summary,
        presentation.recoveryAction?.label,
      ].filter(Boolean).join('，'),
      live: danger ? 'assertive' : 'polite',
    },
  };
}

/** Thin React Native binding: Shared owns presentation, card redaction, status, and raw disclosure. */
export function adaptToolPresentationForMobile(
  item: RenderTimelineItem,
  gate?: RawPresentationGate,
): MobilePresentationSurface {
  const presentation = selectToolPresentation(item, gate);
  return surface(
    item.id,
    'tool',
    presentation,
    selectPresentationCardViewModel(item, presentation),
  );
}

/** Runtime errors use the safe fallback before renderer- or domain-specific classification. */
export function adaptErrorPresentationForMobile(
  item: RenderTimelineItem,
  gate?: RawPresentationGate,
): MobilePresentationSurface {
  return surface(item.id, 'error', selectErrorPresentation(item, gate));
}

/** Existing BusinessStep surfaces receive this Shared-owned semantic projection. */
export function adaptBusinessStepPresentationForMobile(
  event: BusinessStepEventItem,
  gate?: RawPresentationGate,
): MobilePresentationSurface {
  return surface(event.id, 'business_step', selectBusinessStepPresentation(event, gate));
}

/** Unknown future kinds render a disabled generic card and never disclose raw values. */
export function adaptUnknownPresentationForMobile(
  kind: string,
  source: unknown,
): MobilePresentationSurface {
  const presentation = selectSharedPresentation({ kind, source });
  return surface(
    'presentation:unknown',
    'unknown',
    presentation,
    selectUnknownCardViewModel({ id: 'presentation:unknown' }),
  );
}
