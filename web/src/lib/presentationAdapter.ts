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

export interface WebPresentationSurface {
  key: string;
  kind: 'tool' | 'error' | 'business_step' | 'unknown';
  presentation: SharedPresentation;
  card?: CardViewModel;
  semantic: string;
  accessibility: {
    role: 'status' | 'alert';
    label: string;
    live: 'polite' | 'assertive';
  };
}

function surface(
  key: string,
  kind: WebPresentationSurface['kind'],
  presentation: SharedPresentation,
  card?: CardViewModel,
): WebPresentationSurface {
  const danger = presentation.tone === 'danger';
  return {
    key,
    kind,
    presentation,
    ...(card ? { card } : {}),
    semantic: presentationSemanticSignature(presentation),
    accessibility: {
      role: danger ? 'alert' : 'status',
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

/** Thin Web binding: Shared owns presentation, card redaction, status, and raw disclosure. */
export function adaptToolPresentationForWeb(
  item: RenderTimelineItem,
  gate?: RawPresentationGate,
): WebPresentationSurface {
  const presentation = selectToolPresentation(item, gate);
  return surface(
    item.id,
    'tool',
    presentation,
    selectPresentationCardViewModel(item, presentation),
  );
}

/** Runtime errors use the safe fallback before renderer- or domain-specific classification. */
export function adaptErrorPresentationForWeb(
  item: RenderTimelineItem,
  gate?: RawPresentationGate,
): WebPresentationSurface {
  return surface(item.id, 'error', selectErrorPresentation(item, gate));
}

/** Existing BusinessStep components receive this Shared-owned semantic projection. */
export function adaptBusinessStepPresentationForWeb(
  event: BusinessStepEventItem,
  gate?: RawPresentationGate,
): WebPresentationSurface {
  return surface(event.id, 'business_step', selectBusinessStepPresentation(event, gate));
}

/** Unknown future kinds render a disabled generic card and never disclose raw values. */
export function adaptUnknownPresentationForWeb(
  kind: string,
  source: unknown,
): WebPresentationSurface {
  const presentation = selectSharedPresentation({ kind, source });
  return surface(
    'presentation:unknown',
    'unknown',
    presentation,
    selectUnknownCardViewModel({ id: 'presentation:unknown' }),
  );
}
