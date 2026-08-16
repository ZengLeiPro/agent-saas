import {
  isKnownValidationCommand,
  planSnapshotValidationChain,
} from './snapshotValidationChain.js';

export type SnapshotAutoRoutingReason =
  | 'snapshot_dependency_restore'
  | 'snapshot_validation';

export function snapshotAutoRoutingReason(
  command: string,
  requestedExecution: unknown,
): SnapshotAutoRoutingReason | undefined {
  if (requestedExecution === 'snapshot') return undefined;
  if (isFrozenDependencyRestore(command)) return 'snapshot_dependency_restore';
  const validation = isKnownValidationCommand(command) || Boolean(planSnapshotValidationChain(command));
  if (!validation) return undefined;
  if (requestedExecution === 'workspace' && containsBuildCommand(command)) return undefined;
  return 'snapshot_validation';
}

function isFrozenDependencyRestore(command: string): boolean {
  if (/[;&|<>\n\r`$]/.test(command)) return false;
  const words = shellWords(command);
  let index = 0;
  while (isStaticEnvAssignment(words[index])) index += 1;
  if (words[index] === 'corepack') index += 1;
  const manager = words[index];
  if (manager !== 'pnpm' && manager !== 'npm') return false;
  const subcommandIndex = findPackageManagerSubcommand(words, index + 1, manager);
  const subcommand = words[subcommandIndex];
  if (manager === 'npm') return subcommand === 'ci' && hasOnlyOptions(words.slice(subcommandIndex + 1));
  if (subcommand !== 'install' && subcommand !== 'i') return false;
  const args = words.slice(subcommandIndex + 1);
  return args.includes('--frozen-lockfile') && hasOnlyOptions(args);
}

function findPackageManagerSubcommand(words: string[], start: number, manager: 'pnpm' | 'npm'): number {
  const optionsWithValue = manager === 'pnpm'
    ? new Set(['--dir', '--filter', '--global-dir', '--store-dir', '-C', '-F'])
    : new Set(['--prefix', '--workspace', '-w']);
  let index = start;
  while (index < words.length) {
    if (optionsWithValue.has(words[index]!)) {
      index += 2;
      continue;
    }
    if (words[index]!.startsWith('-')) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function hasOnlyOptions(words: string[]): boolean {
  const optionsWithValue = new Set([
    '--config-dir',
    '--dir',
    '--filter',
    '--global-dir',
    '--network-concurrency',
    '--reporter',
    '--store-dir',
    '--workspace',
    '-C',
    '-F',
    '-w',
  ]);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (optionsWithValue.has(word)) {
      if (!words[index + 1] || words[index + 1]!.startsWith('-')) return false;
      index += 1;
      continue;
    }
    if (!word.startsWith('-')) return false;
  }
  return true;
}

function containsBuildCommand(command: string): boolean {
  return /(?:^|\s)(?:build|vite\s+build|turbo\s+build)(?:\s|$)/i.test(command);
}

function isStaticEnvAssignment(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/.test(value));
}

function shellWords(command: string): string[] {
  return [...command.matchAll(/"(?:\\.|[^"])*"|'[^']*'|\\.|[^\s]+/g)]
    .map((match) => match[0]!.replace(/^(?:"|')|(?:"|')$/g, ''));
}
