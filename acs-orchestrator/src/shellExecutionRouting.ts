export type SnapshotWorkspaceRoutingReason =
  | 'workspace_git_remote_refresh'
  | 'workspace_inspection';

const READ_ONLY_GIT_COMMANDS = new Set([
  'describe',
  'diff',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-remote',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'status',
]);

const READ_ONLY_COMMANDS = new Set([
  'basename',
  'cut',
  'dirname',
  'du',
  'echo',
  'grep',
  'head',
  'jq',
  'ls',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'stat',
  'tail',
  'tr',
  'true',
  'wc',
]);

/**
 * snapshot 只适合可丢弃的安装、测试和构建。查询工作区，尤其是 git fetch，
 * 必须在持久工作区执行，否则更新只会留在临时副本并在命令结束后消失。
 *
 * 这里只识别一小组能被证明安全的形态。任何动态 Shell、写操作或未知命令
 * 都返回 undefined，继续遵循模型原本请求的 snapshot 语义。
 */
export function snapshotWorkspaceRoutingReason(
  command: string,
): SnapshotWorkspaceRoutingReason | undefined {
  const simpleCommands = splitStaticInspectionChain(command);
  if (!simpleCommands) return undefined;

  let containsGitRemoteRefresh = false;
  for (const simpleCommand of simpleCommands) {
    const tokens = tokenizeStaticCommand(simpleCommand);
    if (!tokens || tokens.length === 0) return undefined;
    const classification = classifySimpleCommand(tokens);
    if (!classification) return undefined;
    if (classification === 'workspace_git_remote_refresh') containsGitRemoteRefresh = true;
  }
  return containsGitRemoteRefresh ? 'workspace_git_remote_refresh' : 'workspace_inspection';
}

function classifySimpleCommand(tokens: string[]): SnapshotWorkspaceRoutingReason | undefined {
  const executable = tokens[0]!;
  if (executable === 'git') return classifyGitCommand(tokens);
  if (executable === 'find') return isReadOnlyFind(tokens) ? 'workspace_inspection' : undefined;
  if (executable === 'sed') return isReadOnlySed(tokens) ? 'workspace_inspection' : undefined;
  if (!READ_ONLY_COMMANDS.has(executable)) return undefined;
  if (executable === 'rg' && hasAnyOption(tokens, ['--pre', '--pre-glob'])) return undefined;
  return 'workspace_inspection';
}

function classifyGitCommand(tokens: string[]): SnapshotWorkspaceRoutingReason | undefined {
  let index = 1;
  while (index < tokens.length) {
    if (tokens[index] === '--no-pager') {
      index += 1;
      continue;
    }
    if (tokens[index] === '-C') {
      const path = tokens[index + 1];
      if (!path || !isSafeWorkspaceRelativePath(path)) return undefined;
      index += 2;
      continue;
    }
    break;
  }

  const subcommand = tokens[index];
  if (!subcommand) return undefined;
  const args = tokens.slice(index + 1);
  if (subcommand === 'fetch') {
    return isOrdinaryFetch(args) ? 'workspace_git_remote_refresh' : undefined;
  }
  if (READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    return hasAnyOption(args, ['--output', '--ext-diff', '--textconv', '--upload-pack'])
      ? undefined
      : 'workspace_inspection';
  }
  if (subcommand === 'branch') return isReadOnlyBranch(args) ? 'workspace_inspection' : undefined;
  if (subcommand === 'config') return isReadOnlyConfig(args) ? 'workspace_inspection' : undefined;
  if (subcommand === 'remote') return isReadOnlyRemote(args) ? 'workspace_inspection' : undefined;
  if (subcommand === 'stash') return isReadOnlyStash(args) ? 'workspace_inspection' : undefined;
  if (subcommand === 'submodule') return isReadOnlySubmodule(args) ? 'workspace_inspection' : undefined;
  if (subcommand === 'tag') return isReadOnlyTag(args) ? 'workspace_inspection' : undefined;
  if (subcommand === 'worktree') return args[0] === 'list' ? 'workspace_inspection' : undefined;
  return undefined;
}

function isOrdinaryFetch(args: string[]): boolean {
  const allowedOptions = new Set([
    '--all',
    '--no-tags',
    '--prune',
    '--prune-tags',
    '--quiet',
    '--tags',
    '--verbose',
    '-p',
    '-q',
    '-v',
  ]);
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (args.some((arg) => arg.startsWith('-') && !allowedOptions.has(arg))) return false;
  if (positional.length > 1) return false;
  return positional.length === 0 || isSafeRemoteName(positional[0]!);
}

function isReadOnlyBranch(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.length === 1) {
    return ['--all', '--list', '--remotes', '--show-current', '-a', '-r'].includes(args[0]!);
  }
  return args[0] === '--list' && args.slice(1).every(isStaticPattern);
}

function isReadOnlyConfig(args: string[]): boolean {
  const remaining = args.filter((arg) => ![
    '--global',
    '--local',
    '--show-origin',
    '--show-scope',
    '--system',
  ].includes(arg));
  const operation = remaining[0];
  if (['--list', '-l'].includes(operation ?? '')) return remaining.length === 1;
  return ['--get', '--get-all', '--get-regexp'].includes(operation ?? '')
    && remaining.length >= 2
    && remaining.slice(1).every(isStaticPattern);
}

function isReadOnlyRemote(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.length === 1 && args[0] === '-v') return true;
  return ['get-url', 'show'].includes(args[0] ?? '') && args.slice(1).every(isStaticPattern);
}

function isReadOnlyStash(args: string[]): boolean {
  return ['list', 'show'].includes(args[0] ?? '');
}

function isReadOnlySubmodule(args: string[]): boolean {
  return ['status', 'summary'].includes(args[0] ?? '');
}

function isReadOnlyTag(args: string[]): boolean {
  if (args.length === 0) return true;
  return ['--list', '-l'].includes(args[0] ?? '') && args.slice(1).every(isStaticPattern);
}

function isReadOnlyFind(tokens: string[]): boolean {
  return !hasAnyOption(tokens, [
    '-delete',
    '-exec',
    '-execdir',
    '-fls',
    '-fprint',
    '-fprint0',
    '-fprintf',
    '-ok',
    '-okdir',
  ]);
}

function isReadOnlySed(tokens: string[]): boolean {
  let script: string | undefined;
  for (const token of tokens.slice(1)) {
    if (['-n', '--quiet', '--silent', '-E', '-r'].includes(token)) continue;
    if (token.startsWith('-')) return false;
    if (!script) {
      script = token;
      continue;
    }
  }
  return script !== undefined && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(script);
}

function hasAnyOption(tokens: string[], options: string[]): boolean {
  return tokens.some((token) => options.some((option) => token === option || token.startsWith(`${option}=`)));
}

function isSafeWorkspaceRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('~') || path.includes('\\')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '..');
}

function isSafeRemoteName(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('/') && !value.includes('..');
}

function isStaticPattern(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/[`$;&|<>]/.test(value);
}

function splitStaticInspectionChain(command: string): string[] | undefined {
  const commands: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = (end: number): boolean => {
    const part = command.slice(start, end).trim();
    if (!part) return false;
    commands.push(part);
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '$' && quote === '"') return undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '`' || char === '$' || char === ';' || char === '\n' || char === '<' || char === '>') {
      return undefined;
    }
    if (char === '&') {
      if (command[index + 1] !== '&' || !push(index)) return undefined;
      index += 1;
      start = index + 1;
      continue;
    }
    if (char === '|') {
      if (command[index + 1] === '|' || !push(index)) return undefined;
      start = index + 1;
    }
  }
  if (quote || escaped || !push(command.length)) return undefined;
  return commands;
}

function tokenizeStaticCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (const char of command) {
    if (escaped) {
      token += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      push();
    } else {
      token += char;
      tokenStarted = true;
    }
  }
  if (quote || escaped) return undefined;
  push();
  return tokens;
}
