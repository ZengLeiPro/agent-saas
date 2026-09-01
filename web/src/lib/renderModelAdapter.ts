import type { MessageItem, RawPresentationGate, RenderModel, RenderTimelineItem } from '@agent/shared';
import { renderSemanticSignature } from '@agent/shared';
import {
  adaptErrorPresentationForWeb,
  adaptToolPresentationForWeb,
  type WebPresentationSurface,
} from './presentationAdapter';

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
  return model.items.map((item) => {
    const presentation = item.kind === 'tool_activity'
      ? adaptToolPresentationForWeb(item, presentationGate)
      : item.kind === 'error'
        ? adaptErrorPresentationForWeb(item, presentationGate)
        : undefined;
    return {
      key: item.id,
      item,
      ...(item.source.type === 'message' || item.source.type === 'activity' ? { message: item.source.message } : {}),
      semantic: presentation?.semantic ?? renderSemanticSignature(item),
      ...(presentation ? { presentation } : {}),
      accessibility: presentation
        ? {
            role: presentation.accessibility.role,
            label: presentation.accessibility.label,
            live: presentation.accessibility.live,
          }
        : {
            role: item.accessibility.role,
            label: item.accessibility.label,
            ...(item.accessibility.live ? { live: item.accessibility.live } : {}),
          },
    };
  });
}
