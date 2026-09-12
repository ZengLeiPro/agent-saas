import type { RunContext } from '../types.js';
import type { ResponsesTransport } from './responsesTransport.js';
export function resolveContinuationBinding(
  transport: ResponsesTransport,
  context: RunContext,
  model: string,
) {
  return transport.getContinuationBindingForRequest
    ? transport.getContinuationBindingForRequest({ context, model })
    : transport.getContinuationBinding?.();
}
