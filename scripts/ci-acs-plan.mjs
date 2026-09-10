#!/usr/bin/env node
// PRs reuse the authoritative ACS classifier; main and manual runs verify the full ACS suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function parseClassification(text) {
  const fields = new Map();
  for (const line of text.trim().split('\n')) {
    const separator = line.indexOf('=');
    assert(separator > 0, 'Invalid ACS classifier output');
    const key = line.slice(0, separator);
    assert(!fields.has(key), `Duplicate ACS classifier field: ${key}`);
    fields.set(key, line.slice(separator + 1));
  }
  for (const key of ['publish', 'contract_check']) {
    assert(['true', 'false'].includes(fields.get(key)), `Invalid ACS classifier ${key}`);
  }
  return {
    required: fields.get('publish') === 'true' || fields.get('contract_check') === 'true',
    reason: fields.get('reason') || 'ACS classifier',
  };
}

export function planAcsCi(eventName, files = null, baseSha = '') {
  assert(['pull_request', 'push', 'workflow_dispatch'].includes(eventName), 'Unsupported CI event');
  if (eventName !== 'pull_request') {
    return { required: true, reason: `${eventName} always verifies the complete ACS suite` };
  }
  assert(Array.isArray(files), 'PR changed files unavailable; refusing to skip ACS checks');
  // Former repair-evidence and native-contract workflows also covered all Server changes.
  // This widens test selection only, not component publication or ACS image selection.
  if (files.some((path) => /^(?:server\/|acs-orchestrator\/|docs\/engineering\/acs-repair\/)/u.test(path)
    || path === 'config/github-workflow-inventory.json'
    || path === 'scripts/ci-acs-plan.mjs'
    || path.startsWith('.github/workflows/'))) {
    return { required: true, reason: 'Unified ACS regression and native-process evidence' };
  }
  const directory = mkdtempSync(join(tmpdir(), 'ci-acs-plan-'));
  try {
    const path = join(directory, 'changed-files.txt');
    writeFileSync(path, `${files.join('\n')}\n`);
    return parseClassification(
      execFileSync('bash', [join(root, '.github/scripts/acs-classify.sh'), path, baseSha], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const argument = (name) => args[args.indexOf(name) + 1];
  assert(args.includes('--event'), 'Missing --event');
  const eventName = argument('--event');
  const baseSha = args.includes('--base') ? argument('--base') : '';
  const headSha = args.includes('--head') ? argument('--head') : '';
  let files = null;
  if (eventName === 'pull_request') {
    for (const sha of [baseSha, headSha]) {
      assert(/^[a-f0-9]{40}$/u.test(sha), 'PR planning requires exact base/head SHAs');
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
    }
    // Preserve the existing ACS gate's base-to-head comparison semantics.
    files = execFileSync('git', ['diff', '--name-only', baseSha, headSha], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  }
  const plan = planAcsCi(eventName, files, baseSha);
  const output = `required=${plan.required}\n`;
  process.stdout.write(output);
  if (args.includes('--output')) appendFileSync(argument('--output'), output);
  if (args.includes('--summary')) {
    appendFileSync(
      argument('--summary'),
      `### ACS CI plan\n\n- result: \`${plan.required ? 'required' : 'not_required'}\`\n- reason: ${plan.reason}\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ACS CI planning failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
