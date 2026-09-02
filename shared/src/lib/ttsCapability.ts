export interface TtsHealthContract {
  ttsAvailable?: unknown;
}

/** Fail-closed client adapter: only the authenticated health contract's literal true enables TTS. */
export function isTtsCapabilityAvailable(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as TtsHealthContract).ttsAvailable === true;
}
