import * as ed25519 from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { toByteArray } from 'base64-js';

ed25519.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed25519.etc.concatBytes(...messages));
const SHA256 = /^[0-9a-f]{64}$/; const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELDS = ['schemaVersion','package','incident','approver','issuedAt','expiresAt','nonce','installedApkDigest','rollbackApkDigest','installedVersionCode','rollbackVersionCode','apkSignerDigest','sourceSha','signatureAlgorithm','keyId','signature'] as const;

export interface EnterpriseRollbackManifest {
  schemaVersion: 1; package: string; incident: string; approver: string; issuedAt: string; expiresAt: string; nonce: string;
  installedApkDigest: string; rollbackApkDigest: string; installedVersionCode: number; rollbackVersionCode: number;
  apkSignerDigest: string; sourceSha: string; signatureAlgorithm: 'Ed25519'; keyId: string; signature: string;
}
export interface EnterpriseRollbackPolicy {
  expectedPackage: string; installedApkDigest: string; installedVersionCode: number; expectedApkSignerDigest: string;
  keyId: string; publicKey: string; now: number; ledger: EnterpriseRollbackLedger;
}
export interface EnterpriseRollbackLedger { nonces: readonly string[]; manifestDigests: readonly string[]; }
export interface EnterpriseRollbackAudit {
  event: 'enterprise_emergency_rollback_authorized'; incident: string; approver: string; nonce: string;
  installedVersionCode: number; rollbackVersionCode: number; installedApkDigest: string; rollbackApkDigest: string;
  apkSignerDigest: string; manifestDigest: string; auditedAt: string;
}
export class EnterpriseRollbackError extends Error { constructor(readonly code: string) { super(code); this.name = 'EnterpriseRollbackError'; } }

function payload(value: Omit<EnterpriseRollbackManifest, 'signature'>): string {
  return JSON.stringify({ schemaVersion:value.schemaVersion,package:value.package,incident:value.incident,approver:value.approver,issuedAt:value.issuedAt,expiresAt:value.expiresAt,nonce:value.nonce,installedApkDigest:value.installedApkDigest,rollbackApkDigest:value.rollbackApkDigest,installedVersionCode:value.installedVersionCode,rollbackVersionCode:value.rollbackVersionCode,apkSignerDigest:value.apkSignerDigest,sourceSha:value.sourceSha,signatureAlgorithm:value.signatureAlgorithm,keyId:value.keyId });
}
export function canonicalEnterpriseRollbackPayload(value: EnterpriseRollbackManifest): string { return payload(value); }
function parse(value: unknown): EnterpriseRollbackManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EnterpriseRollbackError('SCHEMA_INVALID');
  const input = value as Record<string, unknown>; const keys = Object.keys(input).sort(); const expected = [...FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key,index)=>key!==expected[index])) throw new EnterpriseRollbackError('SCHEMA_INVALID');
  const text=(field:string, pattern=ID)=>{const v=input[field];if(typeof v!=='string'||!pattern.test(v))throw new EnterpriseRollbackError('SCHEMA_INVALID');return v;};
  const time=(field:string)=>{const v=text(field,/^.{20,32}$/);if(!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)throw new EnterpriseRollbackError('SCHEMA_INVALID');return v;};
  const integer=(field:string)=>{const v=input[field];if(!Number.isSafeInteger(v)||Number(v)<1)throw new EnterpriseRollbackError('SCHEMA_INVALID');return Number(v);};
  if(input.schemaVersion!==1||input.signatureAlgorithm!=='Ed25519')throw new EnterpriseRollbackError('SCHEMA_INVALID');
  return { schemaVersion:1,package:text('package'),incident:text('incident'),approver:text('approver'),issuedAt:time('issuedAt'),expiresAt:time('expiresAt'),nonce:text('nonce'),installedApkDigest:text('installedApkDigest',SHA256),rollbackApkDigest:text('rollbackApkDigest',SHA256),installedVersionCode:integer('installedVersionCode'),rollbackVersionCode:integer('rollbackVersionCode'),apkSignerDigest:text('apkSignerDigest',SHA256),sourceSha:text('sourceSha',/^[0-9a-f]{40}$/),signatureAlgorithm:'Ed25519',keyId:text('keyId'),signature:text('signature',/^[A-Za-z0-9+/]+={0,2}$/) };
}
export function verifyEnterpriseRollbackManifest(value: unknown, policy: EnterpriseRollbackPolicy): { manifest: EnterpriseRollbackManifest; ledger: EnterpriseRollbackLedger; audit: EnterpriseRollbackAudit } {
  const manifest=parse(value);
  if(manifest.package!==policy.expectedPackage)throw new EnterpriseRollbackError('PACKAGE_MISMATCH');
  if(manifest.installedApkDigest!==policy.installedApkDigest)throw new EnterpriseRollbackError('CROSS_SHA');
  if(manifest.installedVersionCode!==policy.installedVersionCode||manifest.rollbackVersionCode<=manifest.installedVersionCode)throw new EnterpriseRollbackError('VERSION_REGRESSION');
  if(manifest.apkSignerDigest!==policy.expectedApkSignerDigest)throw new EnterpriseRollbackError('WRONG_SIGNER');
  if(manifest.keyId!==policy.keyId)throw new EnterpriseRollbackError('KEY_ID_MISMATCH');
  const ttl=Date.parse(manifest.expiresAt)-Date.parse(manifest.issuedAt);if(ttl<=0||ttl>60*60*1000)throw new EnterpriseRollbackError('TTL_INVALID');
  if(policy.now<Date.parse(manifest.issuedAt)||policy.now>=Date.parse(manifest.expiresAt))throw new EnterpriseRollbackError('MANIFEST_EXPIRED');
  const canonical=canonicalEnterpriseRollbackPayload(manifest); const digest=bytesToHex(sha256(utf8ToBytes(canonical)));
  if(policy.ledger.nonces.includes(manifest.nonce)||policy.ledger.manifestDigests.includes(digest))throw new EnterpriseRollbackError('REPLAY');
  let signature:Uint8Array;let publicKey:Uint8Array;try{signature=toByteArray(manifest.signature);publicKey=toByteArray(policy.publicKey);}catch{throw new EnterpriseRollbackError('SIGNATURE_INVALID');}
  if(signature.length!==64||publicKey.length!==32||!ed25519.verify(signature,utf8ToBytes(canonical),publicKey))throw new EnterpriseRollbackError('SIGNATURE_INVALID');
  const ledger={nonces:[...policy.ledger.nonces.slice(-63),manifest.nonce],manifestDigests:[...policy.ledger.manifestDigests.slice(-63),digest]};
  return {manifest,ledger,audit:{event:'enterprise_emergency_rollback_authorized',incident:manifest.incident,approver:manifest.approver,nonce:manifest.nonce,installedVersionCode:manifest.installedVersionCode,rollbackVersionCode:manifest.rollbackVersionCode,installedApkDigest:manifest.installedApkDigest,rollbackApkDigest:manifest.rollbackApkDigest,apkSignerDigest:manifest.apkSignerDigest,manifestDigest:digest,auditedAt:new Date(policy.now).toISOString()}};
}
