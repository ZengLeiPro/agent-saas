#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function fail(message) {
  throw new Error(`[M60-04] SBOM generation failed: ${message}`);
}
function args(argv) {
  const out = { native: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.slice(2);
    const value = argv[++i];
    if (!key || !value) fail('invalid arguments');
    if (key === 'native') out.native.push(value);
    else out[key] = value;
  }
  return out;
}
function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
function componentsFromLock(contents) {
  const components = new Map();
  let snapshots = false;
  for (const line of contents.split('\n')) {
    if (/^snapshots:\s*$/u.test(line)) {
      snapshots = true;
      continue;
    }
    if (snapshots && /^\S/u.test(line) && !/^snapshots:/u.test(line)) break;
    const match = snapshots ? /^  (?:'([^']+)'|([^:\s][^:]*)):\s*$/u.exec(line) : null;
    const locator = (match?.[1] ?? match?.[2])?.replace(/\(.+\)$/u, '');
    if (!locator) continue;
    const scoped = /^(?<name>@[^/]+\/[^@]+)@(?<version>.+)$/u.exec(locator);
    const plain = /^(?<name>[^@]+)@(?<version>.+)$/u.exec(locator);
    const parsed = scoped ?? plain;
    if (!parsed?.groups || !/^[0-9]/u.test(parsed.groups.version)) continue;
    const key = `npm:${parsed.groups.name}@${parsed.groups.version}`;
    components.set(key, {
      type: 'library',
      name: parsed.groups.name,
      version: parsed.groups.version,
      purl: `pkg:npm/${encodeURIComponent(parsed.groups.name)}@${parsed.groups.version}`,
    });
  }
  return components;
}
function nativeComponents(paths, components) {
  for (const path of paths) {
    const contents = readFileSync(resolve(path), 'utf8');
    for (const line of contents.split('\n')) {
      const pod = /^\s*-\s+([A-Za-z0-9_.+/-]+)\s+\(([^ )]+)\)/u.exec(line);
      const gradle = /^[+\\| ]*---\s+([^: ]+):([^: ]+):([^ ]+)/u.exec(line);
      if (pod)
        components.set(`cocoapods:${pod[1]}@${pod[2]}`, {
          type: 'library',
          name: pod[1],
          version: pod[2],
          purl: `pkg:cocoapods/${encodeURIComponent(pod[1])}@${pod[2]}`,
        });
      if (gradle)
        components.set(`maven:${gradle[1]}:${gradle[2]}@${gradle[3]}`, {
          type: 'library',
          group: gradle[1],
          name: gradle[2],
          version: gradle[3],
          purl: `pkg:maven/${encodeURIComponent(gradle[1])}/${encodeURIComponent(gradle[2])}@${gradle[3]}`,
        });
    }
  }
}

const input = args(process.argv.slice(2));
try {
  const lockPath = resolve(input.lock ?? 'pnpm-lock.yaml');
  const lock = readFileSync(lockPath);
  const lockDigest = sha256(lock);
  const components = componentsFromLock(lock.toString('utf8'));
  nativeComponents(input.native, components);
  const list = [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl));
  if (!list.length) fail('no dependencies were discovered');
  const namespace = `https://agent.kaiyan.net/sbom/${lockDigest.slice(7)}`;
  const spdx = stable({
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `agent-saas-mobile-${basename(lockPath)}`,
    documentNamespace: namespace,
    creationInfo: { created: '1970-01-01T00:00:00Z', creators: ['Tool: agent-saas-m60-04-sbom-1'] },
    packages: list.map((component, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: component.name,
      versionInfo: component.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: component.purl,
        },
      ],
    })),
    externalDocumentRefs: [],
    annotations: [
      {
        annotationDate: '1970-01-01T00:00:00Z',
        annotationType: 'OTHER',
        annotator: 'Tool: agent-saas-m60-04-sbom-1',
        comment: `pnpmLockSha256=${lockDigest}`,
      },
    ],
  });
  const cyclonedx = stable({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${lockDigest.slice(7, 15)}-${lockDigest.slice(15, 19)}-${lockDigest.slice(19, 23)}-${lockDigest.slice(23, 27)}-${lockDigest.slice(27, 39)}`,
    version: 1,
    metadata: {
      timestamp: '1970-01-01T00:00:00Z',
      tools: {
        components: [{ type: 'application', name: 'agent-saas-m60-04-sbom', version: '1.0.0' }],
      },
      properties: [{ name: 'agent-saas:pnpm-lock-sha256', value: lockDigest }],
    },
    components: list.map((component) => ({ ...component, 'bom-ref': component.purl })),
  });
  writeFileSync(resolve(input.spdx), `${JSON.stringify(spdx, null, 2)}\n`);
  writeFileSync(resolve(input.cyclonedx), `${JSON.stringify(cyclonedx, null, 2)}\n`);
  process.stdout.write(`M60-04 SBOM generated components=${list.length} lock=${lockDigest}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
