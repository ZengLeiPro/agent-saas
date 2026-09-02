export const MOBILE_COMPATIBILITY_SCHEMA_VERSION = 1 as const;
export const MOBILE_CAPABILITIES = ['connect', 'send', 'sync', 'upload', 'voice', 'artifact-open'] as const;
export type MobileCapability = typeof MOBILE_CAPABILITIES[number];
export type MobileEnvironment = 'development' | 'staging' | 'production';

export interface MobileCompatibilityPolicyContent {
  schemaVersion: typeof MOBILE_COMPATIBILITY_SCHEMA_VERSION;
  tenantId: string;
  environment: MobileEnvironment;
  appId: string;
  api: { min: number; max: number };
  cacheSchema: { min: number; max: number };
  minSupportedAppVersion: string;
  disabledCapabilities: MobileCapability[];
  blockReason: string;
  owner: string;
  incident: string;
  changeId: string;
  effectiveAt: string;
  expiresAt: string;
  version: number;
  nonce: string;
}

export interface SignedMobileCompatibilityPolicy extends MobileCompatibilityPolicyContent {
  digest: string;
  signatureAlgorithm: 'Ed25519';
  keyId: string;
  signature: string;
}

export type CompatibilityBlockCode =
  | 'POLICY_NOT_EFFECTIVE'
  | 'POLICY_EXPIRED'
  | 'APP_VERSION_BLOCKED'
  | 'API_VERSION_BLOCKED'
  | 'CACHE_SCHEMA_BLOCKED';

export interface MobileCompatibilityClientIdentity {
  tenantId: string;
  environment: MobileEnvironment;
  appId: string;
  appVersion: string;
  apiVersion: number;
  cacheSchemaVersion: number;
}

export type MobileCompatibilityDecision =
  | { status: 'allowed'; disabledCapabilities: readonly MobileCapability[]; policyVersion: number }
  | { status: 'blocked'; code: CompatibilityBlockCode; reason: string; allowedActions: readonly ['logout', 'update']; preserveLocalData: true; policyVersion: number };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const POLICY_FIELDS = [
  'schemaVersion', 'tenantId', 'environment', 'appId', 'api', 'cacheSchema',
  'minSupportedAppVersion', 'disabledCapabilities', 'blockReason', 'owner', 'incident',
  'changeId', 'effectiveAt', 'expiresAt', 'version', 'nonce', 'digest',
  'signatureAlgorithm', 'keyId', 'signature',
] as const;

export class MobileCompatibilityError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'MobileCompatibilityError'; }
}

function record(value: unknown, code = 'POLICY_SCHEMA_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileCompatibilityError(code);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID', 'policy fields are missing or unknown');
  }
}
function text(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID', `${label} invalid`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID', `${label} invalid`);
  }
  return value;
}
function positiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID', `${label} invalid`);
  return Number(value);
}
function range(value: unknown, label: string): { min: number; max: number } {
  const item = record(value); exactKeys(item, ['min', 'max']);
  const min = positiveInt(item.min, `${label}.min`); const max = positiveInt(item.max, `${label}.max`);
  if (min > max) throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID', `${label} regresses`);
  return { min, max };
}

export function parseSignedMobileCompatibilityPolicy(value: unknown): SignedMobileCompatibilityPolicy {
  const input = record(value); exactKeys(input, POLICY_FIELDS);
  if (input.schemaVersion !== 1 || input.signatureAlgorithm !== 'Ed25519') throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID');
  const environment = input.environment;
  if (environment !== 'development' && environment !== 'staging' && environment !== 'production') throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID');
  if (!Array.isArray(input.disabledCapabilities) || new Set(input.disabledCapabilities).size !== input.disabledCapabilities.length
    || input.disabledCapabilities.some((item) => !MOBILE_CAPABILITIES.includes(item as MobileCapability))) throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID');
  const effectiveAt = timestamp(input.effectiveAt, 'effectiveAt'); const expiresAt = timestamp(input.expiresAt, 'expiresAt');
  if (Date.parse(effectiveAt) >= Date.parse(expiresAt)) throw new MobileCompatibilityError('POLICY_SCHEMA_INVALID', 'policy TTL invalid');
  const policy: SignedMobileCompatibilityPolicy = {
    schemaVersion: 1,
    tenantId: text(input.tenantId, 'tenantId'), environment, appId: text(input.appId, 'appId'),
    api: range(input.api, 'api'), cacheSchema: range(input.cacheSchema, 'cacheSchema'),
    minSupportedAppVersion: text(input.minSupportedAppVersion, 'minSupportedAppVersion', SEMVER),
    disabledCapabilities: [...input.disabledCapabilities] as MobileCapability[],
    blockReason: text(input.blockReason, 'blockReason', /^.{1,256}$/u), owner: text(input.owner, 'owner'),
    incident: text(input.incident, 'incident'), changeId: text(input.changeId, 'changeId'),
    effectiveAt, expiresAt, version: positiveInt(input.version, 'version'), nonce: text(input.nonce, 'nonce'),
    digest: text(input.digest, 'digest', SHA256), signatureAlgorithm: 'Ed25519', keyId: text(input.keyId, 'keyId'),
    signature: text(input.signature, 'signature', BASE64),
  };
  return policy;
}

export function mobileCompatibilityPayload(policy: MobileCompatibilityPolicyContent): string {
  return JSON.stringify({
    schemaVersion: policy.schemaVersion, tenantId: policy.tenantId, environment: policy.environment,
    appId: policy.appId, api: policy.api, cacheSchema: policy.cacheSchema,
    minSupportedAppVersion: policy.minSupportedAppVersion, disabledCapabilities: [...policy.disabledCapabilities].sort(),
    blockReason: policy.blockReason, owner: policy.owner, incident: policy.incident, changeId: policy.changeId,
    effectiveAt: policy.effectiveAt, expiresAt: policy.expiresAt, version: policy.version, nonce: policy.nonce,
  });
}

function semverTuple(value: string): [number, number, number] {
  if (!SEMVER.test(value)) throw new MobileCompatibilityError('CLIENT_VERSION_INVALID');
  const [major, minor, patch] = value.split(/[+-]/, 1)[0].split('.').map(Number);
  return [major, minor, patch];
}
function compareSemver(a: string, b: string): number {
  const left = semverTuple(a); const right = semverTuple(b);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

export function assertMobilePolicyBinding(policy: SignedMobileCompatibilityPolicy, client: MobileCompatibilityClientIdentity): void {
  if (policy.tenantId !== client.tenantId) throw new MobileCompatibilityError('POLICY_CROSS_TENANT');
  if (policy.environment !== client.environment) throw new MobileCompatibilityError('POLICY_CROSS_ENVIRONMENT');
  if (policy.appId !== client.appId) throw new MobileCompatibilityError('POLICY_APP_MISMATCH');
}

export function evaluateMobileCompatibility(
  policy: SignedMobileCompatibilityPolicy,
  client: MobileCompatibilityClientIdentity,
  now = Date.now(),
): MobileCompatibilityDecision {
  assertMobilePolicyBinding(policy, client);
  const blocked = (code: CompatibilityBlockCode, reason: string): MobileCompatibilityDecision => ({
    status: 'blocked', code, reason, allowedActions: ['logout', 'update'], preserveLocalData: true, policyVersion: policy.version,
  });
  if (now < Date.parse(policy.effectiveAt)) return blocked('POLICY_NOT_EFFECTIVE', policy.blockReason);
  if (now >= Date.parse(policy.expiresAt)) return blocked('POLICY_EXPIRED', policy.blockReason);
  if (compareSemver(client.appVersion, policy.minSupportedAppVersion) < 0) return blocked('APP_VERSION_BLOCKED', policy.blockReason);
  if (client.apiVersion < policy.api.min || client.apiVersion > policy.api.max) return blocked('API_VERSION_BLOCKED', policy.blockReason);
  if (client.cacheSchemaVersion < policy.cacheSchema.min || client.cacheSchemaVersion > policy.cacheSchema.max) return blocked('CACHE_SCHEMA_BLOCKED', policy.blockReason);
  return { status: 'allowed', disabledCapabilities: policy.disabledCapabilities, policyVersion: policy.version };
}

export function capabilityAllowed(decision: MobileCompatibilityDecision, capability: MobileCapability): boolean {
  return decision.status === 'allowed' && !decision.disabledCapabilities.includes(capability);
}

export interface MobilePolicyReplayState { highestVersion: number; acceptedDigests: readonly string[]; }
export function acceptMobilePolicyVersion(policy: SignedMobileCompatibilityPolicy, state: MobilePolicyReplayState): MobilePolicyReplayState {
  if (policy.version <= state.highestVersion || state.acceptedDigests.includes(policy.digest)) throw new MobileCompatibilityError('POLICY_REPLAYED');
  return { highestVersion: policy.version, acceptedDigests: [...state.acceptedDigests.slice(-31), policy.digest] };
}
