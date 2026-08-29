import type { ShellToolInput } from './shellToolSchema.js';

const SHELL_CONTROL = new Set([
  ';',
  '&',
  '|',
  '>',
  '<',
  '`',
  '$',
  '(',
  ')',
  '{',
  '}',
  '*',
  '?',
  '[',
]);
const RG_SAFE_LONG_FLAGS = new Set([
  '--no-config',
  '--files',
  '--line-number',
  '--ignore-case',
  '--smart-case',
  '--case-sensitive',
  '--fixed-strings',
  '--word-regexp',
  '--line-regexp',
  '--invert-match',
  '--count',
  '--files-with-matches',
  '--files-without-match',
  '--only-matching',
  '--quiet',
  '--no-messages',
  '--text',
  '--crlf',
  '--pcre2',
  '--multiline',
  '--multiline-dotall',
  '--stats',
  '--json',
]);
const RG_SAFE_LONG_VALUE_OPTIONS = new Set([
  '--glob',
  '--iglob',
  '--type',
  '--type-not',
  '--regexp',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--after-context',
  '--before-context',
  '--context',
  '--encoding',
  '--engine',
  '--sort',
  '--sortr',
  '--threads',
  '--replace',
  '--color',
  '--colors',
]);
const RG_SAFE_SHORT_FLAGS = new Set([
  'n',
  'i',
  'S',
  's',
  'F',
  'w',
  'x',
  'v',
  'c',
  'l',
  'o',
  'q',
  'H',
  'h',
  '0',
]);
const RG_SAFE_SHORT_VALUE_OPTIONS = new Set(['g', 't', 'T', 'e', 'm', 'A', 'B', 'C']);

function referencesOutsideWorkingDirectory(token: string): boolean {
  const candidates = [token];
  const equals = token.indexOf('=');
  if (equals >= 0) candidates.push(token.slice(equals + 1));
  return candidates.some((candidate) => {
    const components = candidate.split(/[\\/]/).filter(Boolean);
    return (
      candidate.startsWith('/') ||
      candidate.startsWith('~') ||
      /^[A-Za-z]:[\\/]/.test(candidate) ||
      candidate.startsWith('\\\\') ||
      components.includes('..') ||
      components.includes('node_modules') ||
      components.some((component) => component !== '.' && component.startsWith('.'))
    );
  });
}

function tokenizeSimpleShell(command: string): string[] | undefined {
  if (command.includes('\0') || command.includes('\n') || command.includes('\r')) return undefined;
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  const push = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else {
        if (char === '$' || char === '`' || char === '\\') return undefined;
        token += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "'" || char === '"') {
      tokenStarted = true;
      quote = char;
      continue;
    }
    if (SHELL_CONTROL.has(char)) return undefined;
    if (char === '\\') {
      const next = command[index + 1];
      if (!next || next === '\n' || next === '\r') return undefined;
      tokenStarted = true;
      token += next;
      index += 1;
      continue;
    }
    tokenStarted = true;
    token += char;
  }
  if (quote) return undefined;
  push();
  return tokens;
}

export function parseProvablyReadOnlyRgCommand(command: string): string[] | undefined {
  const tokens = tokenizeSimpleShell(command.trim());
  if (!tokens || tokens[0] !== 'rg' || tokens.some(referencesOutsideWorkingDirectory))
    return undefined;

  let hasNoConfig = false;
  let filesMode = false;
  let lineNumberMode = false;
  let hasExplicitPattern = false;
  let optionsEnded = false;
  const positional: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals >= 0 ? token.slice(0, equals) : token;
      if (RG_SAFE_LONG_FLAGS.has(name)) {
        if (equals >= 0) return undefined;
        if (name === '--no-config') hasNoConfig = true;
        if (name === '--files') filesMode = true;
        if (name === '--line-number') lineNumberMode = true;
        continue;
      }
      if (!RG_SAFE_LONG_VALUE_OPTIONS.has(name)) return undefined;
      if (name === '--regexp') hasExplicitPattern = true;
      if (equals < 0) {
        index += 1;
        if (index >= tokens.length) return undefined;
      }
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token !== '-') {
      if (token.length === 2 && RG_SAFE_SHORT_VALUE_OPTIONS.has(token[1]!)) {
        if (token === '-e') hasExplicitPattern = true;
        index += 1;
        if (index >= tokens.length) return undefined;
        continue;
      }
      const flags = [...token.slice(1)];
      if (!flags.length || flags.some((flag) => !RG_SAFE_SHORT_FLAGS.has(flag))) return undefined;
      if (flags.includes('n')) lineNumberMode = true;
      continue;
    }
    positional.push(token);
  }

  if (!hasNoConfig || filesMode === lineNumberMode) return undefined;
  const paths = filesMode ? positional : hasExplicitPattern ? positional : positional.slice(1);
  if (!filesMode && !hasExplicitPattern && positional.length === 0) return undefined;
  const isWorkingDirectory = (path: string) => path === '.' || path === './' || path === '.\\';
  if (paths.some((path) => !isWorkingDirectory(path))) return undefined;
  if (filesMode ? paths.length > 1 : paths.length !== 1) return undefined;
  return tokens;
}

export function isProvablyReadOnlyShellCommand(command: string): boolean {
  return parseProvablyReadOnlyRgCommand(command) !== undefined;
}

export function resolveShellCallPolicy(input: unknown): { risk: 'safe' } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const command = (input as Partial<ShellToolInput>).command;
  return typeof command === 'string' && isProvablyReadOnlyShellCommand(command)
    ? { risk: 'safe' }
    : undefined;
}
