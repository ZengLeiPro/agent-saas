#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const targetPaths = [
  resolve(root, 'config/github-main-ruleset.json'),
  resolve(root, 'config/github-rc-tag-ruleset.json'),
];
const repository = 'ZengLeiPro/agent-saas';

export function inspectMainRuleset(rulesets, target) {
  const actual = rulesets.find((ruleset) => ruleset.name === target.name);
  if (!actual) return { ok: false, reasons: [`missing ruleset ${target.name}`] };
  const reasons = [];
  if (actual.enforcement !== 'active') reasons.push('ruleset is not active');
  if (actual.target !== 'branch') reasons.push('ruleset target is not branch');
  const includes = actual.conditions?.ref_name?.include ?? [];
  if (!includes.includes('refs/heads/main')) reasons.push('main is not included');
  if ((actual.bypass_actors ?? []).length !== 0)
    reasons.push('unexpected bypass actor is configured');
  const byType = new Map((actual.rules ?? []).map((rule) => [rule.type, rule]));
  for (const type of ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']) {
    if (!byType.has(type)) reasons.push(`missing ${type} rule`);
  }
  const pullRequest = byType.get('pull_request')?.parameters ?? {};
  if (pullRequest.require_code_owner_review !== false)
    reasons.push('CODEOWNER review must stay optional for single-maintainer merges');
  if (pullRequest.require_last_push_approval !== false)
    reasons.push('last-push approval must stay disabled for single-maintainer merges');
  if (pullRequest.required_review_thread_resolution !== true)
    reasons.push('conversation resolution is not required');
  if (Number(pullRequest.required_approving_review_count ?? 0) !== 0)
    reasons.push('approving review count must be zero for single-maintainer merges');
  const checks = byType.get('required_status_checks')?.parameters ?? {};
  const contexts = (checks.required_status_checks ?? []).map((check) => check.context);
  for (const context of ['Build & Check', 'ACS Impact Gate']) {
    if (!contexts.includes(context)) reasons.push(`missing required check ${context}`);
  }
  if (checks.strict_required_status_checks_policy !== true)
    reasons.push('strict status checks are disabled');
  return { ok: reasons.length === 0, reasons };
}

export function inspectRcTagRuleset(rulesets, target) {
  const actual = rulesets.find((ruleset) => ruleset.name === target.name);
  if (!actual) return { ok: false, reasons: [`missing ruleset ${target.name}`] };
  const reasons = [];
  if (actual.enforcement !== 'active') reasons.push('RC tag ruleset is not active');
  if (actual.target !== 'tag') reasons.push('RC ruleset target is not tag');
  const includes = actual.conditions?.ref_name?.include ?? [];
  if (!includes.includes('refs/tags/rc-*')) reasons.push('RC tag namespace is not included');
  if ((actual.bypass_actors ?? []).length !== 0)
    reasons.push('unexpected RC tag bypass actor is configured');
  const byType = new Map((actual.rules ?? []).map((rule) => [rule.type, rule]));
  for (const type of ['deletion', 'update']) {
    if (!byType.has(type)) reasons.push(`missing RC tag ${type} rule`);
  }
  return { ok: reasons.length === 0, reasons };
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

function listDetailedRulesets() {
  const summaries = ghJson(['api', `repos/${repository}/rulesets?per_page=100`]);
  return summaries.map((summary) => ghJson(['api', `repos/${repository}/rulesets/${summary.id}`]));
}

function verify() {
  const targets = targetPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
  const rulesets = listDetailedRulesets();
  const results = [
    inspectMainRuleset(rulesets, targets[0]),
    inspectRcTagRuleset(rulesets, targets[1]),
  ];
  const reasons = results.flatMap((result) => result.reasons);
  if (reasons.length) {
    process.stderr.write(`${reasons.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('main and immutable RC tag rulesets verified\n');
}

function option(name) {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function apply() {
  if (option('--confirm') !== repository) {
    throw new Error(`Pass --confirm=${repository} for this exact repository`);
  }
  const repo = ghJson(['api', `repos/${repository}`]);
  if (repo.permissions?.admin !== true)
    throw new Error('GitHub Administration write permission is required');
  const targets = targetPaths.map((path) => ({
    path,
    value: JSON.parse(readFileSync(path, 'utf8')),
  }));
  const before = listDetailedRulesets();
  const backupPath = resolve(
    option('--backup') ??
      `.release-evidence/github-rulesets-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, `${JSON.stringify(before, null, 2)}\n`, { flag: 'wx' });
  for (const target of targets) {
    const existing = before.find((ruleset) => ruleset.name === target.value.name);
    execFileSync(
      'gh',
      [
        'api',
        '--method',
        existing ? 'PUT' : 'POST',
        `repos/${repository}/rulesets${existing ? `/${existing.id}` : ''}`,
        '--input',
        target.path,
      ],
      { stdio: 'inherit' },
    );
  }
  process.stdout.write(`Ruleset applied; rollback snapshot: ${backupPath}\n`);
  verify();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? '--verify';
  if (command === '--verify') verify();
  else if (command === '--apply') apply();
  else
    throw new Error(
      'Usage: github-ruleset.mjs [--verify|--apply --confirm=OWNER/REPO --backup=PATH]',
    );
}
