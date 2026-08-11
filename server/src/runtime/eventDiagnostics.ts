import type { PlatformEvent } from './types.js';

export const INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES = [
  'model_request_started',
  'model_request_checkpoint',
  'model_request_finished',
] as const satisfies readonly PlatformEvent['type'][];

export function isInternalModelDiagnosticEvent(event: PlatformEvent): boolean {
  return (INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES as readonly string[]).includes(event.type);
}
