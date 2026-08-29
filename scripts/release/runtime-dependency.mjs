#!/usr/bin/env node
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

export const RUNTIME_DEPENDENCY_KIND = 'agent-saas-runtime-dependency-contract';
export const RUNTIME_IDENTITY_KIND = 'agent-saas-runtime-dependency-identity';
export const RUNTIME_COMPONENTS = Object.freeze([
  'server',
  'runtimeWorker',
  'acsOrchestrator',
  'adminRunner',
  'acsSandbox',
]);
const IMAGE_PATTERN = /^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u;
const ARCHITECTURES = new Set(['x64', 'arm64']);
const FORBIDDEN_KEY = /(secret|token|password|credential|private.?key|access.?key)/iu;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^/\s:@]+:[^/\s@]+@|\/(?:home|Users|workspace)\/)/u;

function assertKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed))
    throw new Error(`${label} fields must be exactly [${allowed.join(', ')}]`);
}

function assertStringArray(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length)
    throw new Error(`${label} must be a non-empty unique array`);
  for (const entry of value) {
    if (typeof entry !== 'string' || (allowed && !allowed.has(entry)))
      throw new Error(`${label} contains unsupported value ${String(entry)}`);
  }
}

function assertNoSensitiveData(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveData(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key))
        throw new Error(`Runtime dependency field ${path}.${key} is sensitive`);
      assertNoSensitiveData(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && FORBIDDEN_VALUE.test(value))
    throw new Error(`Runtime dependency value ${path} contains sensitive or host-specific data`);
}

export function validateRuntimeDependencyContract(contract) {
  assertNoSensitiveData(contract);
  assertKeys(contract, ['schemaVersion', 'kind', 'node', 'baseImages', 'tools'], 'contract');
  if (contract.schemaVersion !== 1 || contract.kind !== RUNTIME_DEPENDENCY_KIND)
    throw new Error('Unsupported runtime dependency contract');
  assertKeys(contract.node, ['version', 'platform', 'architectures', 'components'], 'node');
  if (!VERSION_PATTERN.test(contract.node.version) || contract.node.platform !== 'linux')
    throw new Error('Node contract must declare an exact Linux version');
  assertStringArray(contract.node.architectures, ARCHITECTURES, 'node.architectures');
  assertStringArray(contract.node.components, new Set(RUNTIME_COMPONENTS), 'node.components');

  if (!Array.isArray(contract.baseImages) || contract.baseImages.length === 0)
    throw new Error('baseImages must not be empty');
  const imageNames = new Set();
  for (const image of contract.baseImages) {
    assertKeys(image, ['name', 'reference', 'architecture', 'components'], 'baseImage');
    if (!NAME_PATTERN.test(image.name) || imageNames.has(image.name))
      throw new Error(`Invalid or duplicate base image ${String(image.name)}`);
    imageNames.add(image.name);
    if (!IMAGE_PATTERN.test(image.reference))
      throw new Error(`Base image ${image.name} must use an immutable registry digest`);
    if (!ARCHITECTURES.has(image.architecture))
      throw new Error(`Base image ${image.name} has unsupported architecture`);
    assertStringArray(image.components, null, `baseImage.${image.name}.components`);
  }

  if (!Array.isArray(contract.tools)) throw new Error('tools must be an array');
  const toolIdentities = new Set();
  for (const tool of contract.tools) {
    assertKeys(tool, ['name', 'version', 'architecture', 'components', 'probe'], 'tool');
    if (!NAME_PATTERN.test(tool.name) || !VERSION_PATTERN.test(tool.version))
      throw new Error('Tools must declare a normalized name and exact version');
    if (!ARCHITECTURES.has(tool.architecture))
      throw new Error(`Tool ${tool.name} has unsupported architecture`);
    assertStringArray(tool.components, new Set(RUNTIME_COMPONENTS), `tool.${tool.name}.components`);
    assertStringArray(tool.probe, null, `tool.${tool.name}.probe`);
    const identity = `${tool.name}:${tool.architecture}:${tool.components.join(',')}`;
    if (toolIdentities.has(identity)) throw new Error(`Duplicate tool identity ${identity}`);
    toolIdentities.add(identity);
  }
  return contract;
}

export function runtimeDependencyContractDigest(contract) {
  validateRuntimeDependencyContract(contract);
  return digestBuffer(Buffer.from(canonicalJson(contract)));
}

export async function loadRuntimeDependencyContract(
  path = 'config/runtime-dependency-contract.json',
) {
  const contract = JSON.parse(await readFile(resolve(path), 'utf8'));
  validateRuntimeDependencyContract(contract);
  return contract;
}

export function createRuntimeDependencyIdentity(contract, sourceSha) {
  validateRuntimeDependencyContract(contract);
  if (!SHA_PATTERN.test(sourceSha))
    throw new Error('Runtime dependency identity requires a full source SHA');
  const dependencies = {
    node: contract.node,
    baseImages: contract.baseImages,
    tools: contract.tools,
  };
  const dependencyDigest = digestBuffer(Buffer.from(canonicalJson(dependencies)));
  const body = {
    schemaVersion: 1,
    kind: RUNTIME_IDENTITY_KIND,
    sourceSha,
    contractDigest: runtimeDependencyContractDigest(contract),
    dependencyDigest,
    ...dependencies,
  };
  return { ...body, identityDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
}

export function verifyRuntimeDependencyIdentity(identity, expected = {}) {
  assertNoSensitiveData(identity);
  assertKeys(
    identity,
    [
      'schemaVersion',
      'kind',
      'sourceSha',
      'contractDigest',
      'dependencyDigest',
      'node',
      'baseImages',
      'tools',
      'identityDigest',
    ],
    'identity',
  );
  const { identityDigest, ...body } = identity;
  if (
    identity.schemaVersion !== 1 ||
    identity.kind !== RUNTIME_IDENTITY_KIND ||
    !SHA_PATTERN.test(identity.sourceSha)
  )
    throw new Error('Invalid runtime dependency identity');
  if (
    !DIGEST_PATTERN.test(identity.contractDigest) ||
    !DIGEST_PATTERN.test(identity.dependencyDigest) ||
    !DIGEST_PATTERN.test(identityDigest)
  )
    throw new Error('Runtime dependency identity has an invalid digest');
  const calculatedDependencyDigest = digestBuffer(
    Buffer.from(
      canonicalJson({
        node: identity.node,
        baseImages: identity.baseImages,
        tools: identity.tools,
      }),
    ),
  );
  if (calculatedDependencyDigest !== identity.dependencyDigest)
    throw new Error('Runtime dependency digest mismatch');
  if (digestBuffer(Buffer.from(canonicalJson(body))) !== identityDigest)
    throw new Error('Runtime dependency identity digest mismatch');
  const contract = {
    schemaVersion: 1,
    kind: RUNTIME_DEPENDENCY_KIND,
    node: identity.node,
    baseImages: identity.baseImages,
    tools: identity.tools,
  };
  if (runtimeDependencyContractDigest(contract) !== identity.contractDigest)
    throw new Error('Runtime dependency contract digest mismatch');
  if (expected.sourceSha && identity.sourceSha !== expected.sourceSha)
    throw new Error('Runtime dependency source SHA mismatch');
  if (expected.contractDigest && identity.contractDigest !== expected.contractDigest)
    throw new Error('Runtime dependency contract conflicts with the expected release contract');
  return identity;
}

export function verifyRuntimeEnvironment({
  identity,
  component,
  runtime = { version: process.versions.node, arch: process.arch, platform: process.platform },
  execFileSync = defaultExecFileSync,
  checkTools = true,
}) {
  verifyRuntimeDependencyIdentity(identity);
  if (!RUNTIME_COMPONENTS.includes(component) || !identity.node.components.includes(component))
    throw new Error(`Unsupported runtime dependency component ${String(component)}`);
  if (runtime.version !== identity.node.version)
    throw new Error(
      `Node version mismatch: expected ${identity.node.version}, got ${runtime.version}`,
    );
  if (!identity.node.architectures.includes(runtime.arch))
    throw new Error(
      `Node architecture mismatch: expected ${identity.node.architectures.join('|')}, got ${runtime.arch}`,
    );
  if (runtime.platform !== identity.node.platform)
    throw new Error(
      `Node platform mismatch: expected ${identity.node.platform}, got ${runtime.platform}`,
    );
  if (checkTools) {
    for (const tool of identity.tools.filter((entry) => entry.components.includes(component))) {
      if (tool.architecture !== runtime.arch)
        throw new Error(
          `Tool ${tool.name} architecture mismatch: expected ${tool.architecture}, got ${runtime.arch}`,
        );
      let output;
      try {
        output = execFileSync(tool.probe[0], tool.probe.slice(1), {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch {
        throw new Error(`Required runtime tool ${tool.name} is missing or not executable`);
      }
      const exactVersion = new RegExp(
        `(?:^|[^0-9])${tool.version.replaceAll('.', '\\.').replaceAll('+', '\\+')}(?:$|[^0-9])`,
        'u',
      );
      if (!exactVersion.test(String(output)))
        throw new Error(`Runtime tool ${tool.name} version mismatch: expected ${tool.version}`);
    }
  }
  return { component, dependencyDigest: identity.dependencyDigest };
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((entry) => {
      const [key, ...value] = entry.replace(/^--/u, '').split('=');
      return [key, value.length ? value.join('=') : true];
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode ?? 'enforce');
  if (args.create === 'true') {
    if (!args.contract || !args['source-sha'] || !args.output)
      throw new Error(
        'usage: runtime-dependency.mjs --create=true --contract=<path> --source-sha=<sha> --output=<path>',
      );
    const identity = createRuntimeDependencyIdentity(
      await loadRuntimeDependencyContract(String(args.contract)),
      String(args['source-sha']),
    );
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resolve(String(args.output)), `${canonicalJson(identity)}\n`, { flag: 'wx' });
    process.stdout.write(`${identity.dependencyDigest}\n`);
  } else if (args.production === 'true' && mode !== 'enforce')
    throw new Error('Production runtime dependency checks cannot be disabled');
  else if (mode === 'off') {
    process.stdout.write('runtime-dependency: explicitly disabled outside production\n');
  } else {
    if (!args.manifest || !args.component)
      throw new Error(
        'usage: runtime-dependency.mjs --manifest=<path> --component=<component> [--production=true] [--mode=enforce]',
      );
    const identity = JSON.parse(await readFile(resolve(String(args.manifest)), 'utf8'));
    const result = verifyRuntimeEnvironment({ identity, component: String(args.component) });
    process.stdout.write(`runtime-dependency: ${result.component} ${result.dependencyDigest}\n`);
  }
}
