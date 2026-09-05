#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { constants, copyFile, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function reusableArtifactPlan(manifest) {
  const plan = [];
  for (const [component, field, filename, root] of [
    ['api', 'artifactDigest', 'server-bundle.tgz', '/opt/agent-saas-app/releases'],
    ['acs', 'orchestratorArtifactDigest', 'acs-orchestrator.tgz', '/opt/agent-saas/acs-releases'],
  ]) {
    const selected = manifest.components?.[component];
    if (selected?.action === 'keep') continue;
    if (selected?.action !== 'deploy' || !/^sha256:[a-f0-9]{64}$/u.test(selected[field] ?? '')) {
      throw new Error('Invalid reusable artifact identity: ' + component);
    }
    const digest = selected[field].slice(7);
    plan.push({ filename, digest, source: join(root, digest, '.release', filename) });
  }
  return plan;
}

async function verifyArchive(path, digest) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error('Cached artifact digest mismatch');
}

// 复用只影响传输。复制前后都校验 Manifest 摘要，后续部署仍执行原有制品与安装目录检查。
export async function hydrateArtifacts(plan, outputRoot) {
  let reused = 0;
  for (const entry of plan) {
    const destination = join(outputRoot, 'artifacts', entry.filename);
    try {
      await lstat(destination);
      await verifyArchive(destination, entry.digest);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await verifyArchive(entry.source, entry.digest);
    await copyFile(entry.source, destination, constants.COPYFILE_EXCL);
    await verifyArchive(destination, entry.digest);
    reused += 1;
  }
  return reused;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, manifestPath, outputRoot] = process.argv.slice(2);
  const plan = reusableArtifactPlan(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (action === 'plan') {
    for (const entry of plan) console.log([entry.filename, entry.digest, entry.source].join('\t'));
  } else if (action === 'hydrate' && outputRoot) {
    console.log(JSON.stringify({ reusedArtifacts: await hydrateArtifacts(plan, outputRoot) }));
  } else {
    throw new Error('usage: reuse-promotion-artifacts.mjs <plan|hydrate> <manifest> [output-root]');
  }
}
