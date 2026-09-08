export interface PublishedIdentity {
  schemaVersion: 1;
  digest: string;
  credentialVersionDigest?: string;
}
export interface PublishedVersion {
  revision: string;
  rawRevision: string;
  identity: PublishedIdentity;
}
export interface ProcessIdentity {
  pid: number;
  startTicks: string;
  bootId: string;
}
export interface ConfigPublication extends PublishedVersion {
  schemaVersion: 1;
  environment: 'production';
  releaseId: string;
  phase: 'committed' | 'applying' | 'rolling_back' | 'recovery_required';
  sequence: number;
  actor: string;
  changedPaths: string[];
  updatedAt: string;
  previous?: PublishedVersion;
  owner?: ProcessIdentity;
}
export function rawRevision(text: string | Buffer): string;
export function canonical(value: unknown): string;
export function authorityDirectory(configPath: string): string;
export function atomicWrite(path: string, text: string, mode?: number): void;
export function processIdentity(pid?: number): ProcessIdentity;
export function isOwnerAlive(owner: ProcessIdentity): boolean;
export function validatePublication(value: unknown): ConfigPublication;
export function readPublication(configPath: string): ConfigPublication | undefined;
export function signingAvailable(configPath: string): boolean;
export function writePublication(configPath: string, input: ConfigPublication): ConfigPublication;
export function saveSnapshot(configPath: string, text: string): string;
export function readSnapshot(configPath: string, digest: string): string;
export function assertPublishedDisk(configPath: string, record?: ConfigPublication): ConfigPublication | undefined;
export function publishedExpected<T extends { schemaVersion: number; digest: string; credentialVersionDigest?: string } | undefined>(configPath: string, releaseId: string | undefined, fallback: T, requireCommitted?: boolean): T | PublishedIdentity;
export function preparePublicationAuthority(configPath: string, releaseId: string, expected: PublishedIdentity): ConfigPublication;
export function publicationEventCount(configPath: string): number;
