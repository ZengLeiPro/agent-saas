#!/usr/bin/env node
// 在任何 job 拿到生产凭据之前，先把一次生产操作的参数校验清楚。
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OPERATIONS = ['promote', 'web-recovery-audit', 'web-recovery-repair'];
const RC_PATTERN = /^rc-[0-9]{8}-[0-9]{2,}$/u;

function text(value, name, fallback = '') {
  if (value === undefined || value === null) return fallback;
  assert.equal(typeof value, 'string', `${name} must be a string`);
  return value;
}

function boolean(value) {
  if (value === undefined || value === false || value === 'false') return false;
  assert(value === true || value === 'true', 'Invalid confirm_recovery_only boolean');
  return true;
}

export function validateProductionOperation(inputs, { eventName, ref }) {
  assert.equal(eventName, 'workflow_dispatch', 'Production operations require workflow_dispatch');
  assert.equal(ref, 'refs/heads/main', 'Production operations require main');
  assert(
    inputs && typeof inputs === 'object' && !Array.isArray(inputs),
    'Missing operation inputs',
  );
  const operation = text(inputs.operation, 'operation', 'promote');
  const releaseId = text(inputs.release_id, 'release_id');
  const digest = text(inputs.expected_plan_digest, 'expected_plan_digest');
  const confirmed = boolean(inputs.confirm_recovery_only);
  assert(OPERATIONS.includes(operation), 'Unknown production operation');
  assert(text(inputs.reason, 'reason').trim(), 'An operation reason is required');
  if (operation === 'promote') {
    // release_id 留空表示发布 OSS 记录中最新的 RC；填写时必须是合法 RC ID。
    assert(releaseId === '' || RC_PATTERN.test(releaseId), 'promote requires a valid release_id');
    assert(!digest && !confirmed, 'Cold-standby confirmation cannot be used for RC promotion');
    return { operation, recoveryMode: '' };
  }
  assert.equal(releaseId, '', 'Cold-standby operations must not specify release_id');
  if (operation === 'web-recovery-audit') {
    assert(!digest && !confirmed, 'Audit must not contain repair authorization');
    return { operation, recoveryMode: 'audit' };
  }
  assert(confirmed, 'Cold-standby repair requires explicit confirm_recovery_only');
  assert(
    /^sha256:[a-f0-9]{64}$/u.test(digest),
    'Cold-standby repair requires a reviewed planDigest',
  );
  return { operation, recoveryMode: 'repair' };
}

export function main(env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const plan = validateProductionOperation(event.inputs, {
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
  });
  // 只输出枚举常量，不把任何多行的不可信输入写进 outputs。
  const output = `operation=${plan.operation}\nrecovery_mode=${plan.recoveryMode}\n`;
  appendFileSync(env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`Production operation rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
