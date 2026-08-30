import type { MessageItem, RawPresentationGate, RenderModel, RenderTimelineItem } from '@agent/shared';
import { renderSemanticSignature } from '@agent/shared';
import { adaptToolPresentationForWeb, type WebPresentationSurface } from './presentationAdapter';

export interface WebRenderTimelineRow {
  key: string;
  item: RenderTimelineItem;
  message?: MessageItem;
  semantic: string;
  presentation?: WebPresentationSurface;
  accessibility: {
    role: RenderTimelineItem['accessibility']['role'];
    label: string;
    live?: 'polite' | 'assertive';
  };
}

/** Thin web-only binding; all semantic decisions live in Shared RenderModel. */
export function adaptRenderModelForWeb(
  model: RenderModel,
  presentationGate?: RawPresentationGate,
): readonly WebRenderTimelineRow[] {
  return model.items.map((item) => ({
    key: item.id,
    item,
    ...(item.source.type === 'message' || item.source.type === 'activity' ? { message: item.source.message } : {}),
    semantic: renderSemanticSignature(item),
    ...(item.kind === 'tool_activity' ? { presentation: adaptToolPresentationForWeb(item, presentationGate) } : {}),
    accessibility: {
      role: item.accessibility.role,
      label: item.accessibility.label,
      ...(item.accessibility.live ? { live: item.accessibility.live } : {}),
    },
  }));
}
