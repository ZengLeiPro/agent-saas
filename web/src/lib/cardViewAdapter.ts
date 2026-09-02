import { cardSemanticSignature, type CardViewModel } from '@agent/shared';

export interface WebCardViewProps {
  key: string;
  model: CardViewModel;
  semanticSignature: string;
}

/** Layout-only Web binding. It must not reinterpret Shared card status or action selectors. */
export function adaptCardViewModelForWeb(model: CardViewModel): WebCardViewProps {
  return { key: model.id, model, semanticSignature: cardSemanticSignature(model) };
}
