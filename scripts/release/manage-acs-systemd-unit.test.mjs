import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const helper = new URL('./manage-acs-systemd-unit.sh', import.meta.url).pathname;
const template = new URL(
  '../../daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template',
  import.meta.url,
).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'acs-managed-unit-'));
  const target = join(root, 'agent-saas-acs-orchestrator.service');
  const backup = join(root, 'unit.backup');
  const log = join(root, 'systemctl.log');
  const systemctl = join(root, 'systemctl');
  await writeFile(systemctl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\n`);
  await chmod(systemctl, 0o755);
  return { root, target, backup, log, systemctl };
}

function bash(script) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n. '${helper}'\n${script}`], {
    encoding: 'utf8',
  });
}

test('managed unit rejects PATH Node and any executable other than /usr/bin/node', async () => {
  const { root } = await fixture();
  const badUnit = join(root, 'bad.service');
  const body = (await readFile(template, 'utf8')).replaceAll('/usr/bin/node', '/opt/node/bin/node');
  await writeFile(badUnit, body);

  const wrongUnit = bash(
    `validate_acs_managed_unit '${badUnit}' /usr/bin/node agent-saas-acs-orchestrator.service`,
  );
  assert.notEqual(wrongUnit.status, 0);
  assert.match(wrongUnit.stderr, /must run the Runtime guard with \/usr\/bin\/node/u);

  const wrongExecutable = bash(
    `validate_acs_managed_unit '${template}' node agent-saas-acs-orchestrator.service`,
  );
  assert.notEqual(wrongExecutable.status, 0);
  assert.match(wrongExecutable.stderr, /requires \/usr\/bin\/node/u);
});

test('first managed upgrade replaces an old unit and rollback restores exact old bytes', async () => {
  const value = await fixture();
  const oldUnit = '[Service]\nExecStart=/usr/local/bin/node legacy.js\n';
  await writeFile(value.target, oldUnit);
  await writeFile(value.backup, oldUnit);

  execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
. '${helper}'
validate_acs_managed_unit '${template}' /usr/bin/node agent-saas-acs-orchestrator.service
install_acs_managed_unit '${template}' '${value.target}' '${value.systemctl}'
restore_acs_managed_unit '${value.target}' '${value.backup}' true '${value.systemctl}'`,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(await readFile(value.target, 'utf8'), oldUnit);
  assert.equal(await readFile(value.log, 'utf8'), 'daemon-reload\ndaemon-reload\n');
});

test('unit bytes are restored even when daemon-reload fails', async () => {
  const value = await fixture();
  const previous = '[Service]\nExecStart=/usr/bin/node previous.js\n';
  await writeFile(value.target, await readFile(template, 'utf8'));
  await writeFile(value.backup, previous);
  await writeFile(
    value.systemctl,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${value.log}'\nexit 1\n`,
  );
  await chmod(value.systemctl, 0o755);

  const result = bash(
    `restore_acs_managed_unit '${value.target}' '${value.backup}' true '${value.systemctl}'`,
  );
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(value.target, 'utf8'), previous);
  assert.equal(await readFile(value.log, 'utf8'), 'daemon-reload\n');
});

test('rollback removes the managed override when no previous /etc unit existed', async () => {
  const value = await fixture();
  const result = bash(
    `install_acs_managed_unit '${template}' '${value.target}' '${value.systemctl}'
restore_acs_managed_unit '${value.target}' '${value.backup}' false '${value.systemctl}'
test ! -e '${value.target}'`,
  );
  assert.equal(result.status, 0, result.stderr);
});
