import { createHash } from 'node:crypto';
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { canonicalJson, SHA_PATTERN } from './artifact-lib.mjs';

const MIGRATION_PATH = /(?:^|\/)(?:migrations?)(?:\/|\.|[A-Z_-])/iu;
const DESTRUCTIVE_PATTERN =
  /\b(?:DROP\s+(?:TABLE|COLUMN|SCHEMA|TYPE)|TRUNCATE\s+TABLE|DELETE\s+FROM|ALTER\s+(?:TABLE\s+\S+\s+)?(?:ALTER\s+COLUMN\s+\S+\s+)?TYPE)\b/iu;

export function isMigrationPath(path) {
  return typeof path === 'string' && MIGRATION_PATH.test(path.replaceAll('\\', '/'));
}

export function createMigrationPlan({
  changedPaths,
  target,
  cwd = process.cwd(),
  execFileSync = defaultExecFileSync,
}) {
  if (!SHA_PATTERN.test(target ?? ''))
    return {
      ok: false,
      migrationPlan: null,
      blockingReasons: ['Migration target SHA is invalid.'],
    };
  const paths = [...new Set(changedPaths.filter(isMigrationPath))].sort();
  const inventory = [];
  const blockingReasons = [];
  for (const path of paths) {
    try {
      const content = String(
        execFileSync('git', ['show', `${target}:${path}`], { cwd, encoding: 'utf8' }),
      );
      if (DESTRUCTIVE_PATTERN.test(content)) {
        blockingReasons.push(
          `Migration ${path} contains a destructive contract operation and cannot be promoted with an RC.`,
        );
      }
      inventory.push({
        path,
        blobDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      });
    } catch {
      blockingReasons.push(
        `Migration ${path} is absent at the release SHA; migration removal requires a separate contract release.`,
      );
    }
  }
  const phase = paths.length === 0 ? 'none' : 'expand';
  const planBody = { schemaVersion: 1, releaseSha: target, phase, files: inventory };
  return {
    ok: blockingReasons.length === 0,
    migrationPlan: {
      phase,
      planDigest: `sha256:${createHash('sha256').update(canonicalJson(planBody)).digest('hex')}`,
      confirmation: phase === 'none' ? 'not_required' : 'required_after_observation',
      contract: 'separate_release',
    },
    blockingReasons,
  };
}

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  if (!options['changed-paths'] || !options.target)
    throw new Error(
      'usage: migration-plan.mjs --changed-paths <classification.json> --target <sha>',
    );
  const input = JSON.parse(await readFile(options['changed-paths'], 'utf8'));
  const result = createMigrationPlan({ changedPaths: input.changedFiles, target: options.target });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
