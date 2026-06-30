import { createHash } from 'node:crypto';

import type { AcsOrchestratorConfig } from './config.js';
import type { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { Kubectl } from './kubectl.js';
import type { ProvisioningLogEntry, SandboxRunnerFinalOutput, WorkspaceRecipe } from './protocol.js';
import type { SandboxManager } from './sandboxManager.js';

const SETUP_DEFAULT_TIMEOUT_MS = 60_000;
const RUNTIME_BOOTSTRAP_TIMEOUT_MS = 360_000;
const SETUP_MAX_OUTPUT_BYTES = 16 * 1024;

export class Provisioner {
  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly sandboxManager: SandboxManager,
    private readonly getBusySandboxNames: () => Set<string> = () => new Set(),
    private readonly activeRegistry?: ActiveSandboxRegistry,
  ) {}

  async provision(recipe: WorkspaceRecipe): Promise<{ status: 'ok' | 'error'; error?: string; logs: ProvisioningLogEntry[]; metadata: Record<string, unknown> }> {
    const logs: ProvisioningLogEntry[] = [];
    const plannedRef = this.sandboxManager.ref({
      workspaceId: recipe.workspaceId,
      sessionId: recipe.sessionId!,
      sandboxScopeId: recipe.sandboxScopeId,
      mountSubPath: recipe.mountSubPath,
    });
    const activeKey = `provision:${recipe.sessionId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
    const releaseActive = this.activeRegistry?.acquire(plannedRef.name, activeKey);
    try {
      const ref = await this.sandboxManager.ensureRunning({
        workspaceId: recipe.workspaceId,
        sessionId: recipe.sessionId!,
        sandboxScopeId: recipe.sandboxScopeId,
        mountSubPath: recipe.mountSubPath,
      }, {
        busySandboxNames: this.getBusySandboxNames(),
        activeKey,
      });
      const recipeHash = createHash('sha256').update(JSON.stringify(provisionFingerprint(recipe))).digest('hex');
      logs.push({
        step: 'sandbox_ensure',
        status: 'ok',
        note: `Sandbox ${ref.name} is running`,
      });
      const timeoutMs = clampTimeoutMs(recipe.resources?.timeoutMs);
      const runtimeBootstrap = await this.runRuntimeBootstrap(ref.name, recipe, Math.max(timeoutMs, RUNTIME_BOOTSTRAP_TIMEOUT_MS));
      logs.push(runtimeBootstrap);
      if (runtimeBootstrap.status === 'error') return this.error('runtime bootstrap failed; see logs[]', logs, recipeHash, 'runtime_bootstrap');

      if (this.config.skipProvisionOnSameRecipe) {
        const existingHash = await this.readProvisionHash(ref.name);
        if (existingHash === recipeHash) {
          logs.push({
            step: 'provision_idempotency',
            status: 'skipped',
            note: 'recipe hash already provisioned',
          });
          return {
            status: 'ok',
            logs,
            metadata: { recipeVersion: 1, recipeHash, sandboxName: ref.name, provisionSkipped: true },
          };
        }
      }

      if (recipe.repo) {
        const command = buildRepoCommand(recipe.repo);
        const log = await this.runSetupCommand(ref.name, 'repo_hydrate', command, timeoutMs);
        logs.push({ ...log, command: redactProvisioningCommand(command) });
        if (log.status === 'error') return this.error('repo hydrate failed; see logs[]', logs, recipeHash, 'repo_hydrate');
      }

      if (recipe.files?.length) {
        for (let i = 0; i < recipe.files.length; i++) {
          const file = recipe.files[i]!;
          const url = file.signedUrl ?? file.url;
          if (!url) {
            logs.push({ step: `artifact_hydrate#${i}`, status: 'error', stderr: 'artifact entry is missing signedUrl/url', note: `artifactId=${file.artifactId}` });
            return this.error('artifact hydrate failed; see logs[]', logs, recipeHash, 'artifact_hydrate');
          }
          const command = `node -e ${shellQuote(artifactDownloadScript())} ${shellQuote(url)} ${shellQuote(file.path)}`;
          const log = await this.runSetupCommand(ref.name, `artifact_hydrate#${i}`, command, timeoutMs);
          logs.push({ ...log, command: 'node -e <artifactDownloadScript> <redacted-url> <path>', note: `artifactId=${file.artifactId}` });
          if (log.status === 'error') return this.error('artifact hydrate failed; see logs[]', logs, recipeHash, 'artifact_hydrate');
        }
      }

      if (recipe.setupCommands?.length) {
        for (let i = 0; i < recipe.setupCommands.length; i++) {
          const command = recipe.setupCommands[i]!;
          const log = await this.runSetupCommand(ref.name, `setup_command#${i}`, command, timeoutMs);
          logs.push(log);
          if (log.status === 'error') return this.error('setup command failed; see logs[]', logs, recipeHash, 'setup_command');
        }
      }

      await this.writeProvisionHash(ref.name, recipeHash).catch((err) => {
        logs.push({
          step: 'provision_receipt_write',
          status: 'error',
          stderr: err instanceof Error ? err.message : String(err),
        });
      });

      return {
        status: 'ok',
        logs,
        metadata: { recipeVersion: 1, recipeHash, sandboxName: ref.name },
      };
    } finally {
      releaseActive?.();
    }
  }

  private async readProvisionHash(sandboxName: string): Promise<string | null> {
    const result = await this.kubectl.run([
      'exec',
      sandboxName,
      '-c',
      this.config.sandboxContainerName,
      '--',
      '/bin/sh',
      '-lc',
      `cd ${shellQuote(this.config.workspaceMountPath)} && cat .ky-agent/runtime/provision/provision-hash 2>/dev/null || true`,
    ], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) return null;
    const hash = result.stdout.trim();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
  }

  private async writeProvisionHash(sandboxName: string, recipeHash: string): Promise<void> {
    const result = await this.kubectl.run([
      'exec',
      sandboxName,
      '-c',
      this.config.sandboxContainerName,
      '--',
      '/bin/sh',
      '-lc',
      `cd ${shellQuote(this.config.workspaceMountPath)} && mkdir -p .ky-agent/runtime/provision && printf %s ${shellQuote(recipeHash)} > .ky-agent/runtime/provision/provision-hash`,
    ], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'write provision hash failed');
  }

  private async runRuntimeBootstrap(sandboxName: string, recipe: WorkspaceRecipe, timeoutMs: number): Promise<ProvisioningLogEntry> {
    const command = runtimeBootstrapCommand(this.config.workspaceMountPath);
    const input = JSON.stringify({
      toolName: 'Shell',
      input: { command, timeoutMs },
      workspace: {
        id: recipe.workspaceId,
        sessionId: recipe.sessionId,
        root: this.config.workspaceMountPath,
      },
    });
    const start = Date.now();
    const result = await this.kubectl.run([
      'exec',
      '-i',
      sandboxName,
      '-c',
      this.config.sandboxContainerName,
      '--',
      '/app/acs-orchestrator/node_modules/.bin/tsx',
      '/app/acs-orchestrator/src/sandboxRunner.ts',
    ], { input, timeoutMs });
    const parsed = parseSandboxRunnerFinal(result.stdout);
    const response = parsed?.response;
    const status = result.exitCode === 0 && response?.status === 'success' ? 'ok' : 'error';
    return {
      step: 'runtime_bootstrap',
      command: 'sandboxRunner Shell <runtime bootstrap>',
      stdout: truncate(response?.status === 'success' ? response.content : result.stdout, SETUP_MAX_OUTPUT_BYTES),
      stderr: truncate(response?.status === 'error' ? response.error : result.stderr, SETUP_MAX_OUTPUT_BYTES),
      exitCode: result.exitCode ?? (result.signal ? 128 : -1),
      durationMs: Date.now() - start,
      status,
      ...(result.signal ? { note: `signal=${result.signal}` } : {}),
    };
  }

  private async runSetupCommand(sandboxName: string, step: string, command: string, timeoutMs: number): Promise<ProvisioningLogEntry> {
    const start = Date.now();
    const result = await this.kubectl.run([
      'exec',
      sandboxName,
      '-c',
      this.config.sandboxContainerName,
      '--',
      '/bin/sh',
      '-lc',
      `cd ${shellQuote(this.config.workspaceMountPath)} && ${command}`,
    ], { timeoutMs });
    return {
      step,
      command,
      stdout: truncate(result.stdout, SETUP_MAX_OUTPUT_BYTES),
      stderr: truncate(result.stderr, SETUP_MAX_OUTPUT_BYTES),
      exitCode: result.exitCode ?? (result.signal ? 128 : -1),
      durationMs: Date.now() - start,
      status: result.exitCode === 0 ? 'ok' : 'error',
      ...(result.signal ? { note: `signal=${result.signal}` } : {}),
    };
  }

  private error(error: string, logs: ProvisioningLogEntry[], recipeHash: string, step: string) {
    return {
      status: 'error' as const,
      error,
      logs,
      metadata: { recipeVersion: 1, recipeHash, retryPolicy: { retryable: true, step, maxAttempts: 3, backoffMs: [1000, 5000, 15000] } },
    };
  }
}

function provisionFingerprint(recipe: WorkspaceRecipe): WorkspaceRecipe {
  const { sessionId: _sessionId, ...stableRecipe } = recipe;
  return stableRecipe;
}

function runtimeBootstrapCommand(workspaceMountPath: string): string {
  const venvPath = `${workspaceMountPath}/.ky-agent/runtime/venv`;
  return [
    'set -eu',
    `test "$VIRTUAL_ENV" = ${shellQuote(venvPath)}`,
    'case ":$PATH:" in *":$VIRTUAL_ENV/bin:"*) ;; *) echo "missing venv bin in PATH: $PATH" >&2; exit 10;; esac',
    'case ":$PATH:" in *":/home/agent/.npm-global/bin:"*) ;; *) echo "missing npm global bin in PATH: $PATH" >&2; exit 11;; esac',
    'case ":$PATH:" in *":/usr/sbin:"*) ;; *) echo "missing /usr/sbin in PATH: $PATH" >&2; exit 12;; esac',
    'test "$(command -v python3)" = "$VIRTUAL_ENV/bin/python3"',
    'test "$(command -v pip)" = "$VIRTUAL_ENV/bin/pip"',
    'python3 - <<\\PY',
    'import sys',
    'assert sys.prefix != sys.base_prefix, (sys.executable, sys.prefix, sys.base_prefix)',
    'print("PYTHON_VENV_READY", sys.executable)',
    'PY',
    'python3 -m pip install --dry-run requests >/dev/null',
    'echo ACS_RUNTIME_BOOTSTRAP_OK',
  ].join('\n');
}

function parseSandboxRunnerFinal(stdout: string): SandboxRunnerFinalOutput | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as SandboxRunnerFinalOutput;
      if (parsed?.kind === 'final' && parsed.response) return parsed;
    } catch {
      // Ignore non-JSON stdout from older runners.
    }
  }
  return null;
}

function buildRepoCommand(repo: NonNullable<WorkspaceRecipe['repo']>): string {
  const remote = repo.remote?.trim() || 'origin';
  const ref = repo.ref?.trim();
  return [
    'if [ -d .git ]; then',
    `git remote set-url ${shellQuote(remote)} ${shellQuote(repo.url)} && git fetch --prune ${shellQuote(remote)}${ref ? ` ${shellQuote(ref)}` : ''}${ref ? ' && git checkout --force FETCH_HEAD' : ''};`,
    'else',
    'if [ "$(find . -mindepth 1 -maxdepth 1 | head -n 1)" ]; then echo "workspace is not empty and is not a git repository" >&2; exit 2; fi;',
    `git clone ${shellQuote(repo.url)} .${ref ? ` && git checkout --force ${shellQuote(ref)}` : ''};`,
    'fi',
  ].join(' ');
}

function artifactDownloadScript(): string {
  return `
const fs = require('node:fs/promises');
const path = require('node:path');
const [url, rel] = process.argv.slice(1);
const root = process.cwd();
const dest = path.resolve(root, rel);
if (!dest.startsWith(root + path.sep)) throw new Error('artifact path escapes workspace');
fetch(url).then(async (res) => {
  if (!res.ok) throw new Error('artifact download HTTP ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  console.log('wrote ' + bytes.length + ' bytes to ' + rel);
}).catch((err) => { console.error(err.message || String(err)); process.exit(1); });
`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function redactProvisioningCommand(command: string): string {
  return command
    .replace(/https:\/\/([^\s/'"]+):([^@\s/'"]+)@/g, 'https://$1:***@')
    .replace(/([?&](?:token|access_token|sig|signature|X-Amz-Signature)=)[^\s'"]+/gi, '$1***');
}

function clampTimeoutMs(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return SETUP_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1_000, Math.floor(requested)), 600_000);
}

function truncate(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf-8');
  if (buf.length <= maxBytes) return value;
  return buf.slice(0, maxBytes).toString('utf-8') + `\n...[truncated ${buf.length - maxBytes} bytes]`;
}
