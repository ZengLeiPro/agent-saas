import type { MessageItem, RenderModel, RenderTimelineItem } from '@agent/shared';
import { renderSemanticSignature } from '@agent/shared';

export interface WebRenderTimelineRow {
  key: string;
  item: RenderTimelineItem;
  message?: MessageItem;
  semantic: string;
  accessibility: {
    role: RenderTimelineItem['accessibility']['role'];
    label: string;
    live?: 'polite' | 'assertive';
  };
}

/** Thin web-only binding; all semantic decisions live in Shared RenderModel. */
export function adaptRenderModelForWeb(model: RenderModel): readonly WebRenderTimelineRow[] {
  return model.items.map((item) => ({
    key: item.id,
    item,
    ...(item.source.type === 'message' || item.source.type === 'activity' ? { message: item.source.message } : {}),
    semantic: renderSemanticSignature(item),
    accessibility: {
      role: item.accessibility.role,
      label: item.accessibility.label,
      ...(item.accessibility.live ? { live: item.accessibility.live } : {}),
    },
  }));
}
