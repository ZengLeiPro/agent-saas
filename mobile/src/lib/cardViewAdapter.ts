import { cardSemanticSignature, type CardViewModel } from '@agent/shared';

export interface MobileCardViewProps {
  key: string;
  model: CardViewModel;
  semanticSignature: string;
}

/** Layout-only Mobile binding. It must not reinterpret Shared card status or action selectors. */
export function adaptCardViewModelForMobile(model: CardViewModel): MobileCardViewProps {
  return { key: model.id, model, semanticSignature: cardSemanticSignature(model) };
}
