#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { verifyPreparedRelease } from './prepared-release.mjs';
import { STAGING_SHARED_ASSET_ENTRIES } from './build-release.mjs';
import { verifyAcsPackage } from './verify-acs-package.mjs';

export async function verifyPackagePaths(root) {
  const absolute = await realpath(root);
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        assert.ok(
          target.startsWith(`${absolute}${sep}`),
          `Package symlink escapes published bundle: ${relative(root, path)}`,
        );
      } else if (info.isDirectory()) await visit(path);
    }
  }
  await visit(root);
}

export async function verifyWebEntryAssets(directory) {
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)].map((match) => match[1]);
  let executable = 0;
  for (const reference of references) {
    if (/^(?:https?:|data:|#|\/\/)/u.test(reference)) continue;
    const pathname = decodeURIComponent(reference.split(/[?#]/u)[0]).replace(/^\//u, '');
    if (!pathname) continue;
    const target = resolve(directory, pathname);
    assert.ok(target.startsWith(`${resolve(directory)}${sep}`), 'Web entry path escaped artifact');
    assert.ok((await lstat(target)).isFile(), `Missing Web entry asset: ${pathname}`);
    if (pathname.endsWith('.js')) executable++;
  }
  assert.ok(executable > 0, 'Web package contains no executable entry asset');
}

export async function verifyReleasePackages({ directory, sourceSha, root = process.cwd() }) {
  const { prepared, index } = await verifyPreparedRelease({ directory, sourceSha, root });
  assert.ok(
    index.artifacts.stagingRuntimeAssets,
    'Prepared release needs actual staging runtime assets',
  );
  const temporary = await mkdtemp(join(tmpdir(), 'release-package-smoke-'));
  try {
    const unpack = (entry, destination) => {
      // Bytes were verified against CI index before extraction. Archives come from our builder.
      execFileSync('tar', ['-xzf', join(directory, entry.path), '-C', destination], {
        stdio: 'inherit',
      });
    };
    const web = join(temporary, 'web');
    const shared = join(temporary, 'shared');
    await Promise.all([mkdir(web), mkdir(shared)]);
    unpack(index.artifacts.serverBundle, temporary);
    unpack(prepared.acsOrchestrator, temporary);
    unpack(index.artifacts.webAssets, web);
    unpack(index.artifacts.stagingRuntimeAssets, shared);
    await verifyPackagePaths(join(temporary, 'server'));
    await verifyPackagePaths(join(temporary, 'acs-orchestrator'));
    await verifyWebEntryAssets(web);
    await verifyAcsPackage(join(temporary, 'acs-orchestrator'), temporary);
    for (const path of STAGING_SHARED_ASSET_ENTRIES) await lstat(join(shared, path));
    for (const component of ['server', 'acs-orchestrator']) {
      const componentRoot = join(temporary, component);
      await lstat(join(componentRoot, 'dist', 'index.js'));
      const manifest = JSON.parse(await readFile(join(componentRoot, 'package.json'), 'utf8'));
      // Some dependencies intentionally expose only subpaths (for example MCP SDK).
      // Validate shipped package metadata; actual entry startup resolves the real imports.
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        await lstat(join(componentRoot, 'node_modules', name, 'package.json'));
      }
      assert.ok(manifest.name, 'Package metadata is missing');
    }
    for (const role of ['server', 'runtime-worker']) {
      const template = await readFile(
        join(
          temporary,
          'server',
          'daemon-packaging',
          'systemd',
          `agent-saas-${role}@.service.template`,
        ),
        'utf8',
      );
      assert.match(
        template,
        /^WorkingDirectory=\/opt\/agent-saas-app\/(?:color|worker)\/%i\/server$/mu,
      );
      assert.match(template, /^ExecStart=\/usr\/bin\/node --enable-source-maps dist\/index\.js$/mu);
      await lstat(join(temporary, 'server', 'dist', 'runtime-dependency.mjs'));
    }
    for (const scenario of ['e2e', 'worker-handoff']) {
      execFileSync(
        'pnpm',
        [
          '--filter',
          'server',
          'exec',
          'tsx',
          'scripts/verify-runtime-multiprocess-e2e.mts',
          '--scenario',
          scenario,
          '--server-bundle',
          join(temporary, 'server'),
          '--shared-assets',
          shared,
        ],
        {
          cwd: root,
          stdio: 'inherit',
          timeout: 180_000,
          env: { ...process.env, MP_WORKER_PROCESS_ROLE: 'runtime-worker' },
        },
      );
    }
    return {
      status: 'passed',
      sourceSha,
      preparedDigest: prepared.digest,
      checks: [
        'published-dependencies',
        'relative-systemd-entry',
        'web-entry-assets',
        'acs-entry-auth-and-graceful-exit',
        'api-worker-pg-roundtrip',
        'worker-generation-handoff',
      ],
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
      if (!match) throw new Error('Expected --key=value');
      return [match[1], match[2]];
    }),
  );
  console.log(
    JSON.stringify(
      await verifyReleasePackages({ directory: options.directory, sourceSha: options.sha }),
    ),
  );
}
