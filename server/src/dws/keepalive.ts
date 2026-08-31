import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { UserInfo } from '../data/users/types.js';
import type { UserStore } from '../data/users/store.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import { deriveStableWorkspaceId } from '../runtime/workspaceIdentity.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { DWS_CONNECTOR_SANDBOX_RESOURCES } from './sandboxResources.js';
import type {
  DwsAuthCheckResult,
  DwsConnectionRecord,
  DwsConnectionStore,
  DwsProfileMetadata,
} from './store.js';

const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_MAX_CHECKS_PER_RUN = 4;
const DWS_STATUS_TIMEOUT_MS = 60_000;
const MAX_PROFILES_FILE_BYTES = 1024 * 1024;
const MAX_PROFILES_PER_USER = 100;
const MAX_SUPPORTED_PROFILES_VERSION = 3;

export interface DwsAuthStatusRunnerOptions {
  agentCwd: string;
  serverRemote?: {
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  };
  resolveServerRemote?: (user: UserInfo) => Promise<{
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  }>;
  /** 测试注入；生产使用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface DwsAuthStatusRunnerLike {
  check(user: UserInfo, connection: DwsConnectionRecord, signal?: AbortSignal): Promise<DwsAuthCheckResult>;
}

export class DwsAuthStatusRunner implements DwsAuthStatusRunnerLike {
  constructor(private readonly options: DwsAuthStatusRunnerOptions) {}

  async check(user: UserInfo, connection: DwsConnectionRecord, signal?: AbortSignal): Promise<DwsAuthCheckResult> {
    const serverRemote = await resolveServerRemote(this.options, user);
    const transport = new HttpTransport({
      baseUrl: serverRemote.baseUrl,
      authToken: serverRemote.authToken,
      invokeTimeoutMs: serverRemote.invokeTimeoutMs,
      fetchImpl: this.options.fetchImpl,
    });
    const userCwd = resolveUserCwd(this.options.agentCwd, user);
    const mountSubPath = deriveWorkspaceMountSubPath(this.options.agentCwd, userCwd);
    if (!mountSubPath) throw new Error('无法解析 DWS 用户工作区挂载路径');
    const workspaceId = deriveStableWorkspaceId(user, `dws-${user.id}`);
    const sessionId = `dws-keepalive-${user.id}`;
    const sandboxScopeId = `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
    const command = `dws auth status --profile ${shellQuote(connection.profileId)} --format json --timeout 30`;

    const response = await transport.invoke({
      toolName: 'Shell',
      input: { command, timeoutMs: DWS_STATUS_TIMEOUT_MS },
      context: {
        invocationId: `dws-keepalive-${randomUUID()}`,
        signal,
        workspace: {
          id: workspaceId,
          root: userCwd,
          userId: user.id,
          username: user.username,
          tenantId: user.tenantId,
          sessionId,
          sandboxScopeId,
          mountSubPath,
          executionTarget: 'server-remote',
          sandboxResources: DWS_CONNECTOR_SANDBOX_RESOURCES,
        },
      },
    });
    if (response.status === 'error') throw new Error(compactError(response.error));

    const payload = parseAuthStatusOutput(response.content);
    const authenticated = payload.authenticated === true;
    if (authenticated) assertDwsProfileIdentity(connection, payload);
    const refreshTokenValid = payload.refresh_token_valid === true;
    return {
      authenticated,
      tokenValid: payload.token_valid === true,
      refreshTokenValid,
      refreshed: payload.refreshed === true,
      ...(stringField(payload.expires_at) ? { expiresAt: stringField(payload.expires_at) } : {}),
      ...(stringField(payload.refresh_expires_at) ? { refreshExpiresAt: stringField(payload.refresh_expires_at) } : {}),
      ...(stringField(payload.corp_name) ? { corpName: stringField(payload.corp_name) } : {}),
      ...(stringField(payload.user_id) ? { dingtalkUserId: stringField(payload.user_id) } : {}),
      ...(stringField(payload.user_name) ? { dingtalkUserName: stringField(payload.user_name) } : {}),
      ...(!authenticated || !refreshTokenValid
        ? { error: stringField(payload.reason) ?? 'not_authenticated' }
        : {}),
    };
  }
}

async function resolveServerRemote(
  options: DwsAuthStatusRunnerOptions,
  user: UserInfo,
): Promise<{ baseUrl: string; authToken: string; invokeTimeoutMs?: number }> {
  const resolved = options.resolveServerRemote
    ? await options.resolveServerRemote(user)
    : options.serverRemote;
  if (!resolved) throw new Error('当前用户没有可用的 DWS 执行环境');
  return resolved;
}

export interface DwsAuthKeepaliveServiceOptions {
  agentCwd: string;
  userStore: Pick<UserStore, 'listAll' | 'findById'>;
  connectionStore: DwsConnectionStore;
  runner: DwsAuthStatusRunnerLike;
  scanIntervalMs?: number;
  initialDelayMs?: number;
  maxChecksPerRun?: number;
  isExecutionEnabled?: () => boolean | Promise<boolean>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class DwsAuthKeepaliveService {
  private readonly workerId = `dws-${process.pid}-${randomUUID()}`;
  private readonly scanIntervalMs: number;
  private readonly initialDelayMs: number;
  private readonly maxChecksPerRun: number;
  private initialTimer?: NodeJS.Timeout;
  private intervalTimer?: NodeJS.Timeout;
  private currentAbort?: AbortController;
  private running = false;
  private stopped = true;

  constructor(private readonly options: DwsAuthKeepaliveServiceOptions) {
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxChecksPerRun = options.maxChecksPerRun ?? DEFAULT_MAX_CHECKS_PER_RUN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.initialTimer = setTimeout(() => {
      void this.runOnce();
      this.intervalTimer = setInterval(() => void this.runOnce(), this.scanIntervalMs);
      this.intervalTimer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
    this.options.logger?.info(`DWS auth keepalive enabled: interval=${this.scanIntervalMs}ms maxChecks=${this.maxChecksPerRun}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
    this.currentAbort?.abort();
  }

  async runOnce(now = new Date(), options: { allowStopped?: boolean } = {}): Promise<void> {
    const allowStopped = options.allowStopped === true;
    if (this.running || (this.stopped && !allowStopped)) return;
    if (this.options.isExecutionEnabled && !await this.options.isExecutionEnabled()) return;
    this.running = true;
    try {
      await this.syncProfileMetadata(now);
      for (let index = 0; index < this.maxChecksPerRun && (!this.stopped || allowStopped); index += 1) {
        const connection = await this.options.connectionStore.claimDue(this.workerId, now);
        if (!connection) break;
        await this.checkClaimed(connection, now);
      }
    } catch (err) {
      this.options.logger?.warn(`DWS auth keepalive scan failed: ${compactError(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async syncProfileMetadata(now: Date): Promise<void> {
    const users = this.options.userStore.listAll().filter((user) => !user.disabled);
    for (const user of users) {
      try {
        const profiles = await readDwsProfiles(resolveUserCwd(this.options.agentCwd, user));
        if (profiles === null) continue;
        await this.options.connectionStore.syncProfiles({
          tenantId: user.tenantId,
          userId: user.id,
          username: user.username,
        }, profiles, now);
      } catch (err) {
        this.options.logger?.warn(`DWS profile metadata scan failed user=${user.id}: ${compactError(err)}`);
      }
    }
  }

  private async checkClaimed(connection: DwsConnectionRecord, now: Date): Promise<void> {
    const user = this.options.userStore.findById(connection.userId);
    if (!user || user.disabled || user.tenantId !== connection.tenantId) {
      await this.options.connectionStore.completeCheck(connection, this.workerId, {
        authenticated: false,
        tokenValid: false,
        refreshTokenValid: false,
        refreshed: false,
        error: user?.disabled ? 'user_disabled' : 'user_missing',
      }, now);
      return;
    }

    const controller = new AbortController();
    this.currentAbort = controller;
    try {
      const result = await this.options.runner.check(user, connection, controller.signal);
      await this.options.connectionStore.completeCheck(connection, this.workerId, result, now);
      if (!result.authenticated || !result.refreshTokenValid) {
        this.options.logger?.warn(`DWS auth disconnected user=${user.id} profile=${connection.profileId}`);
      } else {
        this.options.logger?.info(`DWS auth checked user=${user.id} profile=${connection.profileId} refreshed=${result.refreshed}`);
      }
    } catch (err) {
      if (this.stopped && controller.signal.aborted) {
        await this.options.connectionStore.releaseClaim(connection, this.workerId).catch(() => undefined);
        return;
      }
      await this.options.connectionStore.failCheck(connection, this.workerId, compactError(err), now);
      this.options.logger?.warn(`DWS auth check failed user=${user.id} profile=${connection.profileId}: ${compactError(err)}`);
    } finally {
      if (this.currentAbort === controller) this.currentAbort = undefined;
    }
  }
}

export async function readDwsProfiles(userCwd: string): Promise<DwsProfileMetadata[] | null> {
  const filePath = resolve(userCwd, '.dws/config/profiles.json');
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!fileStat.isFile()) return null;
  if (fileStat.size > MAX_PROFILES_FILE_BYTES) throw new Error('profiles.json 超过 1 MiB，拒绝解析');

  return parseDwsProfilesJson(await readFile(filePath, 'utf-8'));
}

interface ParsedDwsProfile extends DwsProfileMetadata {
  profileName?: string;
}

export function parseDwsProfilesJson(rawJson: string): DwsProfileMetadata[] {
  const parsed = JSON.parse(rawJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('profiles.json 格式无效');
  }
  const document = parsed as Record<string, unknown>;
  if (Object.hasOwn(document, 'version')) {
    if (typeof document.version !== 'number'
      || !Number.isInteger(document.version)
      || document.version < 1) {
      throw new Error('profiles.json version 格式无效');
    }
    if (document.version > MAX_SUPPORTED_PROFILES_VERSION) {
      throw new Error(`profiles.json version ${document.version} 超出当前支持范围`);
    }
  }
  const rawProfiles = Array.isArray(document.profiles) ? document.profiles : [];
  if (rawProfiles.length > MAX_PROFILES_PER_USER) {
    throw new Error(`profiles.json profile 数量超过 ${MAX_PROFILES_PER_USER}，拒绝截断解析`);
  }
  const baseProfiles = rawProfiles.flatMap((raw): ParsedDwsProfile[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const corpId = boundedString(item.corpId, 512);
    if (!corpId) return [];
    const profileName = boundedString(item.name, 512);
    const dingtalkUserId = boundedString(item.userId, 512);
    return [{
      profileId: '',
      corpId,
      ...(profileName ? { profileName } : {}),
      ...(boundedString(item.corpName, 512) ? { corpName: boundedString(item.corpName, 512) } : {}),
      ...(dingtalkUserId ? { dingtalkUserId } : {}),
      ...(boundedString(item.userName, 512) ? { dingtalkUserName: boundedString(item.userName, 512) } : {}),
      ...(boundedString(item.status, 64) ? { profileStatus: boundedString(item.status, 64) } : {}),
      ...(boundedString(item.expiresAt, 128) ? { expiresAt: boundedString(item.expiresAt, 128) } : {}),
      ...(boundedString(item.refreshExpAt, 128) ? { refreshExpiresAt: boundedString(item.refreshExpAt, 128) } : {}),
      ...(boundedString(item.lastLoginAt, 128) ? { lastLoginAt: boundedString(item.lastLoginAt, 128) } : {}),
      ...(boundedString(item.lastUsedAt, 128) ? { lastUsedAt: boundedString(item.lastUsedAt, 128) } : {}),
      ...(boundedString(item.updatedAt, 128) ? { updatedAt: boundedString(item.updatedAt, 128) } : {}),
    }];
  });
  const profiles = baseProfiles.map(profile => ({
    ...profile,
    profileId: dwsProfileSelectionSelector(profile, baseProfiles),
  }));
  const selectors = new Set<string>();
  for (const profile of profiles) {
    if (selectors.has(profile.profileId)) {
      throw new Error(`profiles.json 包含重复或无法区分的 profile selector：${profile.profileId}`);
    }
    selectors.add(profile.profileId);
  }

  const hasCurrentProfile = Object.hasOwn(document, 'currentProfile');
  const currentProfile = boundedString(document.currentProfile, 512);
  if (hasCurrentProfile && !currentProfile) {
    throw new Error('profiles.json currentProfile 格式无效');
  }
  if (!currentProfile) return profiles;
  const currentIndex = resolveDwsProfilePointer(
    currentProfile,
    profiles,
    stringMap(document.orgCurrentProfiles),
  );
  if (currentIndex === undefined) {
    throw new Error(`profiles.json currentProfile 无法唯一解析：${currentProfile}`);
  }
  return profiles.map((profile, index) => index === currentIndex ? { ...profile, isCurrent: true } : profile);
}

function dwsProfileSelectionSelector(profile: ParsedDwsProfile, profiles: ParsedDwsProfile[]): string {
  if (profile.dingtalkUserId) return `${profile.corpId}:${profile.dingtalkUserId}`;
  const sameCorp = profiles.filter(candidate => candidate.corpId === profile.corpId);
  if (sameCorp.length === 1) return profile.corpId;
  const name = profile.profileName;
  const nameIsSafe = Boolean(name
    && !name.includes(':')
    && !name.startsWith('@legacy/')
    && profiles.filter(candidate => candidate.profileName === name).length === 1
    && !profiles.some(candidate => candidate.corpId === name || candidate.corpName === name));
  if (nameIsSafe) return name!;
  return `@legacy/${Buffer.from(profile.corpId).toString('base64url')}`;
}

function resolveDwsProfilePointer(
  pointer: string,
  profiles: ParsedDwsProfile[],
  orgCurrentProfiles: Map<string, string>,
): number | undefined {
  const direct = matchingProfileIndexes(profiles, profile => profile.profileId === pointer);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;

  const sameCorp = matchingProfileIndexes(profiles, profile => profile.corpId === pointer);
  if (sameCorp.length > 0) {
    const orgCurrent = orgCurrentProfiles.get(pointer);
    if (orgCurrent) {
      const selected = resolveDwsProfilePointerWithoutOrg(orgCurrent, profiles);
      return selected !== undefined && profiles[selected]?.corpId === pointer ? selected : undefined;
    }
    return sameCorp.length === 1 ? sameCorp[0] : undefined;
  }
  return resolveDwsProfilePointerWithoutOrg(pointer, profiles);
}

function resolveDwsProfilePointerWithoutOrg(pointer: string, profiles: ParsedDwsProfile[]): number | undefined {
  const direct = matchingProfileIndexes(profiles, profile => profile.profileId === pointer);
  if (direct.length === 1) return direct[0];
  const byName = matchingProfileIndexes(profiles, profile => profile.profileName === pointer);
  return byName.length === 1 ? byName[0] : undefined;
}

function matchingProfileIndexes(
  profiles: ParsedDwsProfile[],
  predicate: (profile: ParsedDwsProfile) => boolean,
): number[] {
  const indexes: number[] = [];
  profiles.forEach((profile, index) => {
    if (predicate(profile)) indexes.push(index);
  });
  return indexes;
}

function stringMap(value: unknown): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).flatMap(([key, entry]) => {
    const safeKey = boundedString(key, 512);
    const safeValue = boundedString(entry, 512);
    return safeKey && safeValue ? [[safeKey, safeValue]] : [];
  }));
}

export function parseAuthStatusOutput(content: string): Record<string, unknown> {
  const stdoutMarker = '[stdout]\n';
  const start = content.indexOf(stdoutMarker);
  const stdout = start >= 0 ? content.slice(start + stdoutMarker.length).split('\n[stderr]\n', 1)[0]!.trim() : content.trim();
  const jsonStart = stdout.indexOf('{');
  const jsonEnd = stdout.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error('DWS auth status 未返回 JSON');
  const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('DWS auth status JSON 格式无效');
  const record = parsed as Record<string, unknown>;
  if (record.success !== true) throw new Error(stringField(record.message) ?? 'DWS auth status 返回失败');
  return record;
}

function deriveWorkspaceMountSubPath(agentCwd: string, userCwd: string): string | undefined {
  const mountRoot = resolve(agentCwd, '..');
  const rel = relative(mountRoot, resolve(userCwd));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assertDwsProfileIdentity(
  connection: DwsConnectionRecord,
  payload: Record<string, unknown>,
): void {
  const selectorIdentity = parseExactDwsProfileSelector(connection.profileId);
  const expectedCorpId = connection.corpId?.trim() || selectorIdentity?.corpId;
  const expectedUserId = connection.dingtalkUserId?.trim() || selectorIdentity?.dingtalkUserId;
  const actualCorpId = stringField(payload.corp_id);
  const actualUserId = stringField(payload.user_id);
  if (!expectedCorpId || !actualCorpId || actualCorpId !== expectedCorpId) {
    throw new Error(`DWS profile 组织不匹配：期望 ${expectedCorpId ?? 'unknown'}，实际 ${actualCorpId ?? 'unknown'}`);
  }
  if (expectedUserId && (!actualUserId || actualUserId !== expectedUserId)) {
    throw new Error(`DWS profile 账号不匹配：期望 ${expectedUserId}，实际 ${actualUserId ?? 'unknown'}`);
  }
}

function parseExactDwsProfileSelector(
  selector: string,
): { corpId: string; dingtalkUserId: string } | undefined {
  const separator = selector.indexOf(':');
  if (separator <= 0 || separator >= selector.length - 1) return undefined;
  const corpId = selector.slice(0, separator).trim();
  const dingtalkUserId = selector.slice(separator + 1).trim();
  return corpId && dingtalkUserId ? { corpId, dingtalkUserId } : undefined;
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000) || 'unknown_error';
}
