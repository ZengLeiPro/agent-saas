import { describe, expect, it } from 'vitest';
import {
  createInteractionReducerState,
  reduceInteraction,
  selectInteraction,
  selectInteractionCardViewModel,
} from '@agent/shared';
import { adaptCardViewModelForMobile } from '../../../mobile/src/lib/cardViewAdapter';
import { adaptCardViewModelForWeb } from './cardViewAdapter';

describe('M50-02 Web/Mobile card semantic parity', () => {
  it('consumes the identical Shared view model without reinterpreting status, actions, or a11y', () => {
    const identity = { sessionId: 's', interactionId: 'i', generation: 1 };
    const reducer = reduceInteraction(createInteractionReducerState(1), { type: 'server_pending', ...identity });
    const model = selectInteractionCardViewModel({
      sessionId: 's', interactionId: 'i', kind: 'ask_user',
      state: selectInteraction(reducer, 's', 'i'), pending: true,
      questions: [{ header: '选择', question: '请选择', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
    });
    const web = adaptCardViewModelForWeb(model);
    const mobile = adaptCardViewModelForMobile(model);
    expect(web.key).toBe(mobile.key);
    expect(web.model).toBe(mobile.model);
    expect(web.semanticSignature).toBe(mobile.semanticSignature);
    expect(web.semanticSignature).toContain('A');
  });
});
