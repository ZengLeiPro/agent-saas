import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SandboxControlMode = 'daemon' | 'oneshot';
type Execve = (file: string, args: string[], env: Record<string, string>) => never;

/**
 * Replace, do not proxy. A surviving Node parent could expose the control stdin
 * and receipt key through /proc/<pid>/fd to a same-UID tool. The Python entry
 * becomes non-dumpable before reading any input. Only --owned-child runs tools.
 * Both executables and helpers are immutable image assets, not workspace PATH.
 */
export function handoverSandboxControl(mode: SandboxControlMode, options: {
  moduleUrl?: string;
  execve?: Execve;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
} = {}): never {
  const platform = options.platform ?? process.platform;
  const execve = options.execve ?? (process as typeof process & { execve?: Execve }).execve;
  if (platform !== 'linux' || !execve) throw new Error('Isolated sandbox control requires Linux and pinned Node execve support');
  const script = join(dirname(fileURLToPath(options.moduleUrl ?? import.meta.url)), 'remote', 'runner_daemon.py');
  if (!(options.exists ?? existsSync)(script)) throw new Error('Isolated sandbox control bundle is missing');
  const executable = '/usr/local/bin/python3';
  const args = [executable, '-I', script, ...(mode === 'oneshot' ? ['--oneshot'] : [])];
  // These are the existing Pod environment values, not caller-supplied tool env.
  // No additional environment variable or persisted secret is introduced.
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  execve(executable, args, environment);
  throw new Error('Sandbox control execve unexpectedly returned');
}
