/**
 * Parse PERSONA.md content, separating editor hints from actual persona body.
 *
 * Editor hints are the leading section consisting of:
 * - Title lines (starting with `#`)
 * - Blockquote lines (starting with `>`)
 * - Blank lines between them
 *
 * Everything after this header is the actual persona content for prompt injection.
 */
export function parsePersona(content: string): { hints: string; body: string } {
  const lines = content.split('\n');
  let headerEnd = 0;
  const hintLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed === '') {
      if (trimmed.startsWith('>')) {
        hintLines.push(trimmed.slice(1).trim());
      }
      headerEnd = i + 1;
    } else {
      break;
    }
  }

  return {
    hints: hintLines.join('\n').trim(),
    body: lines.slice(headerEnd).join('\n').trim(),
  };
}
