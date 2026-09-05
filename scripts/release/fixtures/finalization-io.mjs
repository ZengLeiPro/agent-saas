#!/usr/bin/env node
// 自动收尾集成测试：仅替换 SSH/HTTP/云存储；校验器、状态机与凭证写入均执行真实代码。
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.env.FINALIZATION_TEST_ROOT;
const scenario = process.env.FINALIZATION_TEST_SCENARIO;
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const log = (message) => appendFileSync(join(root, 'events'), message + '\n');
const fixture = () => JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
const quit = (status = 0) => process.exit(status);
if (command === 'ssh') {
  const remote = args.at(-1);
  if (remote.includes(' -- hold ')) {
    writeFileSync(join(root, 'lock'), 'held');
    setInterval(() => {
      if (existsSync(join(root, 'released'))) quit();
    }, 20);
  } else if (remote.includes(' -- assert ')) {
    quit(existsSync(join(root, 'lock')) && !existsSync(join(root, 'lost')) ? 0 : 1);
  } else if (remote.includes(' -- release ')) {
    writeFileSync(join(root, 'released'), 'released');
    quit();
  } else if (remote.includes('read-live-production-components.mjs')) {
    const final = remote.includes('live-final.json');
    log(final ? 'read-final' : 'read-initial');
    const live = fixture().live;
    live.observedAt = new Date().toISOString();
    if (final && scenario === 'drift') live.components.web.gitSha = 'f'.repeat(40);
    writeFileSync(
      join(root, final ? 'live-final.json' : 'live-initial.json'),
      JSON.stringify(live),
    );
    quit();
  } else if (remote.startsWith('mkdir -p ') || remote.startsWith('rm -rf -- ')) quit();
  else throw new Error('Unexpected SSH: ' + remote);
} else if (command === 'scp') {
  const source = args.at(-2);
  if (source.includes('@')) copyFileSync(join(root, basename(source)), args.at(-1));
} else if (command === 'curl') {
  const ready = fixture().apiReady;
  if (scenario === 'ready-fail') ready.status = 'error';
  process.stdout.write(JSON.stringify(ready));
} else if (command === 'bash' && args[0]?.includes('upload-')) {
  const github = args[0].includes('github-release');
  const source = github ? args[2] : args[1];
  const operation = github
    ? 'github-upload'
    : source.endsWith('migration-confirmation.json')
      ? 'evidence-upload'
      : 'oss-mirror';
  log(operation);
  if (scenario === operation) quit(1);
  if (operation === 'evidence-upload' && scenario === 'lock-loss') {
    writeFileSync(join(root, 'lost'), 'lost');
    quit();
  }
  copyFileSync(
    source,
    join(root, operation === 'github-upload' ? 'github.jsonl' : operation + '.json'),
  );
} else if (command === 'pnpm') {
  log('append-completed');
  const cli = process.env.FINALIZATION_ATTESTATION_CLI;
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args.slice(3)], { stdio: 'inherit' })
    : spawnSync(process.env.FINALIZATION_REAL_PNPM, args, { stdio: 'inherit' });
  quit(result.status ?? 1);
} else if (command === 'bash') {
  quit(spawnSync('/bin/bash', args, { stdio: 'inherit' }).status ?? 1);
} else throw new Error('Unexpected command: ' + command);
