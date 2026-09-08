import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildEvidenceWriter } from './build-evidence-writer.mjs';

test('real Writer deployment restores a failed candidate and retries the same immutable package', async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'writer-deploy-')));
  t.after(async () => {
    execFileSync('chmod', ['-R', 'u+w', temporary]);
    await rm(temporary, { recursive: true, force: true });
  });
  const root = join(temporary, 'host');
  const bin = join(temporary, 'bin');
  await mkdir(join(root, 'releases/legacy'), { recursive: true });
  await mkdir(bin);
  await symlink(join(root, 'releases/legacy'), join(root, 'current'));
  await writeFile(join(root, 'read.token'), 'local-test-token-000000000000000000000000');
  const source = await readFile(new URL('./deploy-evidence-writer.sh', import.meta.url), 'utf8');
  const script = join(temporary, 'deploy.sh');
  await writeFile(
    script,
    source
      .replaceAll('/opt/agent-saas-release-evidence', root)
      .replaceAll('/run/lock/agent-saas-release-evidence', join(root, 'lock'))
      .replaceAll('/etc/agent-saas-staging/release-evidence-read.token', join(root, 'read.token')),
  );
  const command = async (name, body) => {
    const path = join(bin, name);
    await writeFile(path, `#!${process.execPath}\n${body}\n`);
    await chmod(path, 0o755);
  };
  await command('id', "process.stdout.write('0\\n')");
  await command(
    'sudo',
    "const {spawnSync}=require('node:child_process');const r=spawnSync(process.argv[2],process.argv.slice(3),{stdio:'inherit'});process.exit(r.status??1)",
  );
  await command('flock', "process.exit(process.env.TEST_LOCK_FAIL==='true'?1:0)");
  await command('chown', 'process.exit(0)');
  await command('journalctl', 'process.exit(0)');
  await command(
    'systemctl',
    "require('node:fs').appendFileSync(process.env.TEST_HOST+'/events',process.argv.slice(2).join(' ')+'\\n');process.exit(0)",
  );
  await command(
    'sha256sum',
    "const fs=require('node:fs');const h=require('node:crypto').createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');process.stdout.write(h+'  '+process.argv[2]+'\\n')",
  );
  const actualMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
  await command(
    'mv',
    `const args=process.argv.slice(2);if(args[0]==='-Tf'){require('node:fs').renameSync(args[1],args[2]);}else{const r=require('node:child_process').spawnSync(${JSON.stringify(actualMv)},args,{stdio:'inherit'});process.exit(r.status??1)}`,
  );
  await command(
    'curl',
    `if(process.env.TEST_HEALTH_FAIL==='true')process.exit(7);const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.TEST_HOST+'/current/writer-identity.json'));process.stdout.write(JSON.stringify({service:'agent-saas-release-evidence',currentReleaseEvidenceSchemaVersion:value.releaseEvidenceSchemaVersion,releaseEvidenceSchemaRevision:value.releaseEvidenceSchemaRevision,implementationDigest:value.implementationDigest}));`,
  );
  const build = await buildEvidenceWriter(join(temporary, 'build'));
  const args = [
    script,
    build.archivePath,
    build.archiveDigest,
    'a'.repeat(40),
    String(build.releaseEvidenceSchemaVersion),
    String(build.releaseEvidenceSchemaRevision),
    build.implementationDigest,
  ];
  const run = (overrides) =>
    spawnSync('bash', args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_HOST: root, ...overrides },
    });
  const failed = run({ TEST_HEALTH_FAIL: 'true' });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases/legacy'));
  const immutableTarget = join(root, 'releases', build.archiveDigest.slice(7));
  assert.equal(
    (await readFile(join(immutableTarget, '.bundle-digest'), 'utf8')).trim(),
    build.archiveDigest,
  );
  const retry = run({ TEST_HEALTH_FAIL: 'false' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(await readlink(join(root, 'current')), immutableTarget);
  const events = await readFile(join(root, 'events'), 'utf8');
  const locked = run({ TEST_LOCK_FAIL: 'true' });
  assert.equal(locked.status, 1);
  assert.equal(
    await readFile(join(root, 'events'), 'utf8'),
    events,
    'Lock refusal must happen before service mutation',
  );
});
