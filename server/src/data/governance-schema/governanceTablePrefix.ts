const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function governanceTablePrefix(value = 'runtime'): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}
