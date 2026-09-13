#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { constants, copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const ALLOWED_FILES = new Set(['server-bundle.tgz', 'acs-orchestrator.tgz']);
const INTERNAL_OSS_HOST = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.oss-cn-shenzhen-internal\.aliyuncs\.com$/u;

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

export function assertInternalOssUrl(urlString) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:') throw new Error('Artifact URL must be HTTPS');
  if (url.port && url.port !== '443') throw new Error('Artifact URL port not allowed');
  if (url.username || url.password) throw new Error('Artifact URL must not embed userinfo');
  if (!INTERNAL_OSS_HOST.test(url.hostname)) {
    throw new Error('Artifact URL host is not Shenzhen OSS internal');
  }
  if (url.pathname.includes('..') || url.pathname.includes('//')) {
    throw new Error('Artifact URL path is unsafe');
  }
  return url;
}

async function verifyArchive(path, digest) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error('Cached artifact digest mismatch');
}

export async function downloadInternalOssObject(urlString, destination) {
  const url = assertInternalOssUrl(urlString);
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  try {
    await new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 180_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Artifact download HTTP ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(partial, { flags: 'wx' });
        pipeline(res, out).then(resolve, reject);
      });
      req.on('timeout', () => {
        req.destroy(new Error('Artifact download timed out'));
      });
      req.on('error', reject);
    });
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function requireEntry(entry) {
  if (!ALLOWED_FILES.has(entry?.filename) || !/^[a-f0-9]{64}$/u.test(entry?.digest ?? '')) {
    throw new Error('Invalid promotion artifact fetch entry');
  }
  return entry;
}

// 复用只影响传输。复制前后都校验 Manifest 摘要，后续部署仍执行原有制品与安装目录检查。
// 本地缓存未命中时从深圳 OSS 内网预签名 URL 拉取，不经过 GitHub runner。
export async function hydrateArtifacts(plan, outputRoot, { download = downloadInternalOssObject } = {}) {
  const artifacts = Array.isArray(plan) ? plan : plan?.artifacts;
  if (!Array.isArray(artifacts)) throw new Error('Fetch plan artifacts must be an array');
  await mkdir(join(outputRoot, 'artifacts'), { recursive: true });
  let reused = 0;
  let fetched = 0;
  for (const raw of artifacts) {
    const entry = requireEntry(raw);
    const destination = join(outputRoot, 'artifacts', entry.filename);
    try {
      await lstat(destination);
      await verifyArchive(destination, entry.digest);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (entry.source) {
      try {
        await verifyArchive(entry.source, entry.digest);
        await copyFile(entry.source, destination, constants.COPYFILE_EXCL);
        await verifyArchive(destination, entry.digest);
        reused += 1;
        continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!entry.url) throw new Error(`Missing fetch URL for ${entry.filename}`);
    await download(entry.url, destination);
    await verifyArchive(destination, entry.digest);
    if (Number.isSafeInteger(entry.size)) {
      const info = await lstat(destination);
      if (info.size !== entry.size) throw new Error(`Fetched artifact size mismatch: ${entry.filename}`);
    }
    fetched += 1;
  }
  return { reusedArtifacts: reused, fetchedArtifacts: fetched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, inputPath, outputRoot] = process.argv.slice(2);
  if (action === 'plan') {
    const plan = reusableArtifactPlan(JSON.parse(await readFile(inputPath, 'utf8')));
    for (const entry of plan) console.log([entry.filename, entry.digest, entry.source].join('\t'));
  } else if (action === 'hydrate' && outputRoot) {
    const raw = JSON.parse(await readFile(inputPath, 'utf8'));
    console.log(JSON.stringify(await hydrateArtifacts(raw, outputRoot)));
  } else {
    throw new Error(
      'usage: reuse-promotion-artifacts.mjs plan <manifest> | hydrate <fetch-plan> <output-root>',
    );
  }
}
