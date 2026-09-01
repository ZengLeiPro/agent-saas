import type { MessageItem, RawPresentationGate, RenderModel, RenderTimelineItem } from '@agent/shared';
import { renderSemanticSignature } from '@agent/shared';
import {
  adaptErrorPresentationForMobile,
  adaptToolPresentationForMobile,
  type MobilePresentationSurface,
} from './presentationAdapter';

export interface MobileRenderTimelineRow {
  key: string;
  item: RenderTimelineItem;
  message?: MessageItem;
  semantic: string;
  presentation?: MobilePresentationSurface;
  accessibility: {
    role: 'text' | 'summary' | 'alert';
    label: string;
    live?: 'polite' | 'assertive';
  };
}

/** Thin React Native binding; it maps platform vocabulary but owns no message semantics. */
export function adaptRenderModelForMobile(
  model: RenderModel,
  presentationGate?: RawPresentationGate,
): readonly MobileRenderTimelineRow[] {
  return model.items.map((item) => {
    const presentation = item.kind === 'tool_activity'
      ? adaptToolPresentationForMobile(item, presentationGate)
      : item.kind === 'error'
        ? adaptErrorPresentationForMobile(item, presentationGate)
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
            role: item.accessibility.role === 'alert' ? 'alert' : item.accessibility.role === 'status' ? 'summary' : 'text',
            label: item.accessibility.label,
            ...(item.accessibility.live ? { live: item.accessibility.live } : {}),
          },
    };
  });
}
