/** Bundle-only shim: Staging's generated config is strict JSON, not JSONC. */
export function parse(input: string): unknown {
  return JSON.parse(input);
}
