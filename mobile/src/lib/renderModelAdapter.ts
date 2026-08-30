import type { MessageItem, RenderModel, RenderTimelineItem } from '@agent/shared';
import { renderSemanticSignature } from '@agent/shared';

export interface MobileRenderTimelineRow {
  key: string;
  item: RenderTimelineItem;
  message?: MessageItem;
  semantic: string;
  accessibility: {
    role: 'text' | 'summary' | 'alert';
    label: string;
    live?: 'polite' | 'assertive';
  };
}

/** Thin React Native binding; it maps platform vocabulary but owns no message semantics. */
export function adaptRenderModelForMobile(model: RenderModel): readonly MobileRenderTimelineRow[] {
  return model.items.map((item) => ({
    key: item.id,
    item,
    ...(item.source.type === 'message' || item.source.type === 'activity' ? { message: item.source.message } : {}),
    semantic: renderSemanticSignature(item),
    accessibility: {
      role: item.accessibility.role === 'alert' ? 'alert' : item.accessibility.role === 'status' ? 'summary' : 'text',
      label: item.accessibility.label,
      ...(item.accessibility.live ? { live: item.accessibility.live } : {}),
    },
  }));
}
