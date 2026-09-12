import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { createSourceProof } from './staging-source-authority.mjs';
import { sourceFixture, iso } from './fixtures/automatic-release-fixture.mjs';

const gh = `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
const root=process.env.AUTO_FIXTURE, args=process.argv.slice(2);
fs.appendFileSync(p.join(root,'calls.jsonl'),JSON.stringify(args)+'\\n');
if(args.includes('POST')) process.exit(91);
if(args[0]==='run') {
 const out=args[args.indexOf('--dir')+1]; fs.mkdirSync(out,{recursive:true});
 for(const name of fs.readdirSync(p.join(root,'archive'))) fs.copyFileSync(p.join(root,'archive',name),p.join(out,name));
 process.exit(0);
}
const ep=args.find(s=>s.startsWith('repos/')).split('/').slice(3).join('/');
let file=ep.includes('/statuses?')?'statuses':ep.includes('/attempts/')?'attempt':{
 'deployments/801':'deployment','deployments/602':'step','deployments/601':'request',
 'actions/runs/501':'parent','actions/runs/701':'latest'}[ep];
if(!file) process.exit(90);
let value=JSON.parse(fs.readFileSync(p.join(root,file+'.json')));
if(file==='latest' && process.env.AUTO_CASE==='rerun') {
 const n=p.join(root,'reads'); if(fs.existsSync(n)) value.run_attempt=2; fs.writeFileSync(n,'1');
}
if(file==='deployment' && process.env.AUTO_CASE==='marker-removed') {
 const n=p.join(root,'deploy-reads'); if(fs.existsSync(n)) delete value.payload.automaticSource; fs.writeFileSync(n,'1');
}
process.stdout.write(JSON.stringify(value));
`;

for (const mode of [
  'success',
  'missing-proof',
  'wrong-parent',
  'bad-authority',
  'bad-readback',
  'rerun',
  'marker-removed',
]) {
  test(`actual production Bash preflight with source != engine: ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'automatic-preflight-'));
    try {
      const f = sourceFixture();
      f.context.run.status = 'completed';
      f.context.run.conclusion = 'success';
      const proof = createSourceProof(f);
      f.deployment.payload.automaticSource = { digest: proof.digest, stepId: proof.stepId };
      const make = (state, key, at, reason) => ({
        state,
        releaseId: f.manifest.releaseId,
        manifestDigest: f.manifest.digest,
        operationKey: key,
        recordedAt: iso(at),
        ...(reason ? { reason: JSON.stringify(reason) } : {}),
      });
      const history = [
        make('built', 'build:701', f.now - 6000),
        make('staging_deployed', 'staging:701:1', f.now - 4000, {
          stagingRunId: '701',
          stagingRunAttempt: '1',
          stagingDeploymentId: '801',
          manifestDigest: f.manifest.digest,
        }),
        make('verified', 'deterministic:701:1', f.now - 2000),
      ];
      const status = {
        id: 901,
        state: 'success',
        environment: 'staging',
        created_at: iso(f.now),
        deployment_url: `https://api.github.com/repos/${f.repository}/deployments/801`,
        log_url: `https://github.com/${f.repository}/actions/runs/701/attempts/1`,
      };
      await mkdir(join(dir, 'bin'));
      await mkdir(join(dir, 'archive'));
      const smoke = {
        schemaVersion: 1,
        status: 'passed',
        environment: 'staging',
        releaseId: f.manifest.releaseId,
        sourceSha: f.manifest.releaseSha,
        manifestDigest: f.manifest.digest,
        stagingRunId: '701',
        stagingRunAttempt: '1',
        actor: 'staging-e2e-admin',
        checks: ['login', 'authenticated-read', 'persistence-read', 'websocket'],
        observedAt: iso(f.now - 2000),
      };
      const readback = {
        schemaVersion: 1,
        releaseId: f.manifest.releaseId,
        manifestDigest: f.manifest.digest,
        planDigest: f.manifest.migrationPlan.planDigest,
        environment: 'staging',
        observedAt: iso(f.now - 2000),
        status: 'not_required',
        checks: [],
      };
      const values = {
        manifest: f.manifest,
        deployment: f.deployment,
        statuses: [[status]],
        attempt: f.context.run,
        latest: f.context.run,
        parent: f.context.parentRun,
        request: f.context.requestRecord,
        step: f.context.stepRecord,
        'archive/staging-source-binding': proof,
        'archive/authoritative-evidence': f.authority,
        'archive/staging-core-smoke': {
          ...smoke,
          evidenceDigest: digestBuffer(canonicalJson(smoke)),
        },
        'archive/staging-database-readback': readback,
      };
      if (mode === 'wrong-parent') values.request.payload.parentRunId = '999';
      if (mode === 'bad-authority')
        values['archive/authoritative-evidence'].evidenceDigest = 'invalid';
      for (const [name, value] of Object.entries(values))
        await writeFile(join(dir, name + '.json'), JSON.stringify(value));
      if (mode === 'missing-proof') await rm(join(dir, 'archive/staging-source-binding.json'));
      if (mode === 'bad-readback')
        await writeFile(join(dir, 'archive/staging-database-readback.json'), '{"bad":undefined}');
      await writeFile(join(dir, 'history.jsonl'), history.map(JSON.stringify).join('\n'));
      await writeFile(join(dir, 'bin/gh'), gh, { mode: 0o755 });
      const out = join(dir, 'out');
      const result = spawnSync(
        'bash',
        [
          new URL('./verify-staging-promotion-evidence.sh', import.meta.url).pathname,
          join(dir, 'manifest.json'),
          join(dir, 'history.jsonl'),
          out,
        ],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
            GITHUB_REPOSITORY: f.repository,
            AUTO_FIXTURE: dir,
            AUTO_CASE: mode,
          },
        },
      );
      assert.equal(result.status, mode === 'success' ? 0 : 1, result.stdout + result.stderr);
      const report = JSON.parse(await readFile(join(out, 'report.json')));
      assert.equal(report.status, mode === 'success' ? 'passed' : 'rejected');
      const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert(calls.every((c) => !c.includes('POST')));
      if (mode === 'success') {
        assert.equal(report.sourceSha, f.manifest.releaseSha);
        assert.equal(
          JSON.parse(await readFile(join(out, 'source-authority.json'))).proof.engineSha,
          f.context.run.head_sha,
        );
        assert.equal(calls.filter((c) => c.some((s) => s.endsWith('/deployments/601'))).length, 2);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
