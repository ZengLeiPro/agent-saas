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
const BASE_IMAGE_COMPONENTS = new Set([...RUNTIME_COMPONENTS, 'webBuild']);
const REQUIRED_BASE_IMAGE_BINDINGS = new Set([
  'node-alpine:x64:server,webBuild',
  'node-bookworm:x64:acsSandbox',
  'python-bookworm:x64:acsSandbox',
]);
const REQUIRED_TOOL_BINDINGS = new Set([
  'git:x64:server',
  'bird:x64:server',
  'kubectl:x64:acsOrchestrator',
  'aliyun:x64:acsOrchestrator',
  'git:x64:acsSandbox',
  'python:x64:acsSandbox',
  'gh:x64:acsSandbox',
  'aliyun:x64:acsSandbox',
  'gws:x64:acsSandbox',
  'ntn:x64:acsSandbox',
  'bird:x64:acsSandbox',
  'dws:x64:acsSandbox',
  'lark-cli:x64:acsSandbox',
]);
const TOOL_PROBES = new Map([
  ['git', ['git', '--version']],
  ['bird', ['bird', '--version']],
  ['python', ['python3', '--version']],
  ['gh', ['gh', '--version']],
  ['kubectl', ['kubectl', 'version', '--client=true']],
  ['aliyun', ['aliyun', 'version']],
  ['gws', ['gws', '--version']],
  ['ntn', ['ntn', '--version']],
  ['dws', ['dws', '--version']],
  ['lark-cli', ['lark-cli', '--version']],
]);
const IMAGE_PATTERN = /^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const VERSION_TOKEN_PATTERN = /[vV]?[0-9][0-9A-Za-z._+-]*/gu;
const VERSION_CANDIDATE_PATTERN = /^[vV]?\d+\.\d+\./u;
const ARCHITECTURES = new Set(['x64', 'arm64']);
const FORBIDDEN_KEY = /(secret|token|password|credential|private.?key|access.?key)/iu;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^/\s:@]+:[^/\s@]+@|\/(?:root|tmp|home|Users|workspace)\/|authorization\s*:\s*(?:bearer|basic)\s+\S+|bearer\s+[A-Za-z0-9._~+/-]+=*)/iu;

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

function assertExactSet(actual, expected, label) {
  const actualValues = [...actual].sort();
  const expectedValues = [...expected].sort();
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(`${label} must contain the complete supported ownership matrix`);
  }
}

function bindingKey(entry) {
  return `${entry.name}:${entry.architecture}:${[...entry.components].sort().join(',')}`;
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
  assertExactSet(contract.node.components, RUNTIME_COMPONENTS, 'node.components');

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
    assertStringArray(
      image.components,
      BASE_IMAGE_COMPONENTS,
      `baseImage.${image.name}.components`,
    );
  }
  assertExactSet(contract.baseImages.map(bindingKey), REQUIRED_BASE_IMAGE_BINDINGS, 'baseImages');

  if (!Array.isArray(contract.tools)) throw new Error('tools must be an array');
  const toolIdentities = new Set();
  for (const tool of contract.tools) {
    assertKeys(
      tool,
      [
        'name',
        'version',
        'architecture',
        'components',
        'probe',
        ...(Object.hasOwn(tool, 'executableEnvironment') ? ['executableEnvironment'] : []),
        ...(Object.hasOwn(tool, 'when') ? ['when'] : []),
      ],
      'tool',
    );
    if (!NAME_PATTERN.test(tool.name) || !VERSION_PATTERN.test(tool.version))
      throw new Error('Tools must declare a normalized name and exact version');
    if (!ARCHITECTURES.has(tool.architecture))
      throw new Error(`Tool ${tool.name} has unsupported architecture`);
    assertStringArray(tool.components, new Set(RUNTIME_COMPONENTS), `tool.${tool.name}.components`);
    assertStringArray(tool.probe, null, `tool.${tool.name}.probe`);
    const expectedProbe = TOOL_PROBES.get(tool.name);
    if (!expectedProbe || JSON.stringify(tool.probe) !== JSON.stringify(expectedProbe)) {
      throw new Error(`Tool ${tool.name} probe is not the supported fixed version probe`);
    }
    const expectedEnvironment =
      tool.name === 'kubectl' && tool.components.includes('acsOrchestrator')
        ? 'ACS_KUBECTL_PATH'
        : tool.name === 'aliyun' && tool.components.includes('acsOrchestrator')
          ? 'ACS_ALIYUN_CLI_PATH'
          : undefined;
    if (tool.executableEnvironment !== expectedEnvironment) {
      throw new Error(`Tool ${tool.name} has an unsupported executable environment binding`);
    }
    const requiresCondition = tool.name === 'aliyun' && tool.components.includes('acsOrchestrator');
    if (requiresCondition && tool.when === undefined) {
      throw new Error(`Tool ${tool.name} must declare its optional Runtime condition`);
    }
    if (tool.when !== undefined) {
      assertKeys(tool.when, ['environment', 'notEquals', 'defaultValue'], `tool.${tool.name}.when`);
      if (
        !requiresCondition ||
        tool.when.environment !== 'ACS_SNAT_MODE' ||
        tool.when.notEquals !== 'disabled' ||
        tool.when.defaultValue !== 'disabled'
      ) {
        throw new Error(`Tool ${tool.name} has an unsupported runtime condition`);
      }
    }
    const identity = `${tool.name}:${tool.architecture}:${tool.components.join(',')}`;
    if (toolIdentities.has(identity)) throw new Error(`Duplicate tool identity ${identity}`);
    toolIdentities.add(identity);
  }
  assertExactSet(contract.tools.map(bindingKey), REQUIRED_TOOL_BINDINGS, 'tools');
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
  environment = process.env,
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
      const conditionValue = tool.when
        ? String(environment[tool.when.environment] ?? tool.when.defaultValue).trim() ||
          tool.when.defaultValue
        : undefined;
      if (tool.when && conditionValue === tool.when.notEquals) continue;
      if (tool.architecture !== runtime.arch)
        throw new Error(
          `Tool ${tool.name} architecture mismatch: expected ${tool.architecture}, got ${runtime.arch}`,
        );
      let output;
      try {
        const executable = tool.executableEnvironment
          ? String(environment[tool.executableEnvironment] ?? '').trim() || tool.probe[0]
          : tool.probe[0];
        output = execFileSync(executable, tool.probe.slice(1), {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 5_000,
          killSignal: 'SIGKILL',
        });
      } catch {
        throw new Error(`Required runtime tool ${tool.name} is missing or not executable`);
      }
      const versionToken = (String(output).match(VERSION_TOKEN_PATTERN) ?? []).find((token) =>
        VERSION_CANDIDATE_PATTERN.test(token),
      );
      const normalizedVersion =
        tool.name === 'kubectl' ? versionToken?.replace(/^[vV]/u, '') : versionToken;
      if (normalizedVersion !== tool.version || !VERSION_PATTERN.test(normalizedVersion ?? ''))
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
  if (Object.hasOwn(args, 'production') && mode !== 'enforce') {
    throw new Error('Production runtime dependency checks cannot be disabled by any flag form');
  }
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
  } else if (mode === 'off') {
    process.stdout.write('runtime-dependency: explicitly disabled outside production\n');
  } else {
    if (!args.manifest || !args.component)
      throw new Error(
        'usage: runtime-dependency.mjs --manifest=<path> --component=<component> [--production] [--mode=enforce]',
      );
    const identity = JSON.parse(await readFile(resolve(String(args.manifest)), 'utf8'));
    const result = verifyRuntimeEnvironment({ identity, component: String(args.component) });
    process.stdout.write(`runtime-dependency: ${result.component} ${result.dependencyDigest}\n`);
  }
}
