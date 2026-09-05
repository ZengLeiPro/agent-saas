import { createHash } from 'node:crypto';

export function computeRequestInputPrefixHash(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input.slice(0, 8) : [];
  return createHash('sha256')
    .update(
      JSON.stringify({
        instructions: body.instructions,
        tools: body.tools,
        input,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

export function computeRequestPrefixDiagnostics(body: Record<string, unknown>): {
  instructionsHash: string;
  toolsHash: string;
  historyHash: string;
} {
  const hash = (value: unknown) =>
    createHash('sha256')
      .update(JSON.stringify(value ?? null))
      .digest('hex')
      .slice(0, 32);
  return {
    instructionsHash: hash(body.instructions),
    toolsHash: hash(body.tools),
    historyHash: hash(body.input),
  };
}
