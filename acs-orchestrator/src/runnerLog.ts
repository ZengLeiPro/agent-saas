import { createHash } from 'node:crypto';

/** Runner stderr may contain command arguments, credentials or local paths. */
export function summarizeRunnerStderr(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `bytes=${bytes} digest=${digest}`;
}
