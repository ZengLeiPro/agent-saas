import {
  CodexOAuthResponseError,
  hashAccountBinding,
  type CodexCredentialManager,
} from './codexCredentialManager.js';
import {
  CodexWebSocketQuotaExhaustedError,
  CodexWebSocketUnavailableError,
} from './codexResponsesWebSocketPool.js';
import { isCodexQuotaError, quotaErrorCode } from './codexQuota.js';
import type {
  ResponsesTransportExecuteInput,
  ResponsesTransportExecuteResult,
} from './responsesTransport.js';

export class CodexAccountAuthUnavailableError extends Error {
  constructor(readonly code: string, message: string, readonly credentialGeneration?: number) {
    super(message);
    this.name = 'CodexAccountAuthUnavailableError';
  }
}

type LastQuota = {
  kind: 'response';
  result: ResponsesTransportExecuteResult;
} | {
  kind: 'transport_error';
  accountId: string;
  error: CodexWebSocketQuotaExhaustedError;
};

export async function executeCodexCredentialFailover(input: {
  request: ResponsesTransportExecuteInput;
  credentials: CodexCredentialManager;
  credentialRefs: string[];
  executeWithCredential: (
    token: Awaited<ReturnType<CodexCredentialManager['getCredentials']>>,
  ) => Promise<ResponsesTransportExecuteResult>;
}): Promise<ResponsesTransportExecuteResult> {
  let lastQuota: LastQuota | undefined;
  let retainLastQuota = false;
  let earliestCooldownUntil: string | undefined;
  let authUnavailableCount = 0;
  try {
    for (const credentialRef of input.credentialRefs) {
      const runtimeState = await getRuntimeState(input.credentials, credentialRef);
      if (runtimeState?.availability === 'quota_cooldown') {
        if (
          runtimeState.cooldownUntil
          && (!earliestCooldownUntil || runtimeState.cooldownUntil < earliestCooldownUntil)
        ) earliestCooldownUntil = runtimeState.cooldownUntil;
        continue;
      }
      if (runtimeState?.availability === 'auth_unavailable') {
        authUnavailableCount += 1;
        continue;
      }

      let token: Awaited<ReturnType<CodexCredentialManager['getCredentials']>>;
      try {
        token = await getCredentialsForCredential(input.credentials, credentialRef);
      } catch (error) {
        if (!isPermanentCredentialError(error)) throw error;
        await markAuthUnavailable(
          input.credentials,
          credentialRef,
          credentialFailureCode(error),
          await resolveCredentialFailureGeneration(input.credentials, credentialRef, error),
        );
        authUnavailableCount += 1;
        continue;
      }

      try {
        const result = await input.executeWithCredential(token);
        const quotaCode = await codexQuotaResponseCode(result.response);
        if (quotaCode) {
          let cooldownUntil: string;
          try {
            cooldownUntil = await markQuotaCooldown(
              input.credentials,
              credentialRef,
              quotaCode,
              token.generation,
            );
          } catch (error) {
            await result.response.body?.cancel().catch(() => undefined);
            throw error;
          }
          if (!earliestCooldownUntil || cooldownUntil < earliestCooldownUntil) {
            earliestCooldownUntil = cooldownUntil;
          }
          await cancelQuotaResponse(lastQuota);
          lastQuota = { kind: 'response', result };
          continue;
        }
        return result;
      } catch (error) {
        if (isCodexQuotaTransportError(error)) {
          const cooldownUntil = await markQuotaCooldown(
            input.credentials,
            credentialRef,
            error.code,
            token.generation,
          );
          if (!earliestCooldownUntil || cooldownUntil < earliestCooldownUntil) {
            earliestCooldownUntil = cooldownUntil;
          }
          await cancelQuotaResponse(lastQuota);
          lastQuota = { kind: 'transport_error', accountId: token.accountId, error };
          continue;
        }
        if (error instanceof CodexAccountAuthUnavailableError) {
          await markAuthUnavailable(
            input.credentials,
            credentialRef,
            error.code,
            error.credentialGeneration,
          );
          authUnavailableCount += 1;
          continue;
        }
        throw error;
      }
    }

    if (lastQuota) {
      const retryAt = earliestCooldownUntil ?? new Date().toISOString();
      const result = lastQuota.kind === 'response'
        ? await quotaResponseResult(lastQuota.result, retryAt)
        : quotaErrorResult(
          input.request,
          lastQuota.accountId,
          lastQuota.error,
          retryAt,
          input.credentials.getConfiguration().endpoint,
        );
      retainLastQuota = true;
      return result;
    }
    return unavailableAccountsResult(input.request, {
      earliestCooldownUntil,
      authUnavailableCount,
      accountCount: input.credentialRefs.length,
    });
  } finally {
    if (!retainLastQuota) await cancelQuotaResponse(lastQuota);
  }
}

async function getRuntimeState(manager: CodexCredentialManager, credentialRef: string) {
  return (manager as CodexCredentialManager & {
    getRuntimeState?: CodexCredentialManager['getRuntimeState'];
  }).getRuntimeState?.(credentialRef);
}

async function getCredentialsForCredential(manager: CodexCredentialManager, credentialRef: string) {
  const compatible = manager as CodexCredentialManager & {
    getCredentialsForCredential?: CodexCredentialManager['getCredentialsForCredential'];
  };
  return compatible.getCredentialsForCredential
    ? compatible.getCredentialsForCredential(credentialRef)
    : manager.getCredentials(false);
}

async function markQuotaCooldown(
  manager: CodexCredentialManager,
  credentialRef: string,
  code: string,
  credentialGeneration: number,
): Promise<string> {
  const compatible = manager as CodexCredentialManager & {
    markQuotaCooldown?: CodexCredentialManager['markQuotaCooldown'];
  };
  return compatible.markQuotaCooldown
    ? compatible.markQuotaCooldown(credentialRef, code, credentialGeneration)
    : new Date(Date.now() + 60 * 60_000).toISOString();
}

async function markAuthUnavailable(
  manager: CodexCredentialManager,
  credentialRef: string,
  code: string,
  credentialGeneration = 0,
): Promise<void> {
  await (manager as CodexCredentialManager & {
    markAuthUnavailable?: CodexCredentialManager['markAuthUnavailable'];
  }).markAuthUnavailable?.(credentialRef, code, credentialGeneration);
}

export async function isCodexAccountUnavailableResponse(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const text = await response.clone().text().catch(() => '');
  return /account.{0,30}(?:disabled|deactivated|suspended)|subscription.{0,30}(?:inactive|unavailable)/i.test(text);
}

export function isPermanentCredentialError(error: unknown): boolean {
  const oauthError = findOAuthResponseError(error);
  if (oauthError) {
    return oauthError.status >= 400
      && oauthError.status < 500
      && ['invalid_grant', 'invalid_token'].includes(oauthError.code ?? '');
  }
  const message = error instanceof Error ? error.message : String(error);
  return /secret not found|凭据格式损坏|凭据字段不完整|token 缺少/i.test(message);
}

export function credentialFailureGeneration(error: unknown): number {
  if (!error || typeof error !== 'object' || !('credentialGeneration' in error)) return 0;
  const value = Number((error as { credentialGeneration?: unknown }).credentialGeneration);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function resolveCredentialFailureGeneration(
  manager: CodexCredentialManager,
  credentialRef: string,
  error: unknown,
): Promise<number> {
  if (error && typeof error === 'object' && 'credentialGeneration' in error) {
    const explicitGeneration = Number((error as { credentialGeneration?: unknown }).credentialGeneration);
    if (Number.isSafeInteger(explicitGeneration) && explicitGeneration >= 0) return explicitGeneration;
  }
  return (await manager.getRuntimeGeneration(credentialRef)) ?? 0;
}

export function credentialFailureCode(error: unknown): string {
  const oauthError = findOAuthResponseError(error);
  const oauthCode = oauthError?.code;
  if (oauthCode === 'invalid_grant' || oauthCode === 'invalid_token') return oauthCode;
  if (oauthError) return 'credential_unavailable';
  const message = error instanceof Error ? error.message : String(error);
  if (/secret not found/i.test(message)) return 'credential_not_found';
  if (/格式损坏|字段不完整/i.test(message)) return 'credential_invalid';
  return 'credential_unavailable';
}

async function codexQuotaResponseCode(response: Response): Promise<string | undefined> {
  if (response.ok || response.status >= 500) return undefined;
  const text = await response.clone().text().catch(() => '');
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : parsed;
    code = typeof error.code === 'string' ? error.code : undefined;
    message = typeof error.message === 'string' ? error.message : undefined;
  } catch {
    // 非 JSON body 仍交给统一文本判定。
  }
  return isCodexQuotaError({ status: response.status, code, message, rawText: text })
    ? quotaErrorCode({ code, message, rawText: text })
    : undefined;
}

function findOAuthResponseError(error: unknown): CodexOAuthResponseError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof CodexOAuthResponseError) return current;
    seen.add(current);
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function isCodexQuotaTransportError(error: unknown): error is CodexWebSocketQuotaExhaustedError {
  return error instanceof CodexWebSocketQuotaExhaustedError
    || (error instanceof CodexWebSocketUnavailableError && error.reason === 'quota_exhausted');
}

function unavailableAccountsResult(
  input: ResponsesTransportExecuteInput,
  state: { earliestCooldownUntil?: string; authUnavailableCount: number; accountCount: number },
): ResponsesTransportExecuteResult {
  const onlyAuthUnavailable = state.authUnavailableCount === state.accountCount;
  return {
    response: new Response(JSON.stringify({
      error: {
        code: onlyAuthUnavailable ? 'codex_accounts_auth_unavailable' : 'codex_accounts_cooling_down',
        message: onlyAuthUnavailable
          ? '所有 Codex 授权账号均不可用，请重新授权'
          : '所有可用 Codex 授权账号均处于额度冷却期',
        ...(state.earliestCooldownUntil ? { retryAt: state.earliestCooldownUntil } : {}),
      },
    }), {
      status: onlyAuthUnavailable ? 401 : 429,
      headers: { 'content-type': 'application/json' },
    }),
    wireMode: 'http_sse_full',
    wireRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
  };
}

function quotaErrorResult(
  input: ResponsesTransportExecuteInput,
  accountId: string,
  error: CodexWebSocketQuotaExhaustedError,
  retryAt: string,
  issuer: string,
): ResponsesTransportExecuteResult {
  const body = JSON.stringify({
    error: {
      code: error.code || quotaErrorCode({ message: error.message }),
      message: error.message,
      retryAt,
    },
  });
  return {
    response: new Response(body, {
      status: error.status,
      headers: { 'content-type': 'application/json' },
    }),
    continuationBinding: {
      provider: 'openai_codex_subscription',
      issuer,
      accountBindingHash: hashAccountBinding(accountId),
    },
    wireMode: 'http_sse_full',
    wireRequestBodyBytes: Buffer.byteLength(input.serializedBody, 'utf8'),
  };
}

async function quotaResponseResult(
  result: ResponsesTransportExecuteResult,
  retryAt: string,
): Promise<ResponsesTransportExecuteResult> {
  const original = result.response;
  const text = await original.text();
  const headers = new Headers(original.headers);
  const retryAfterSeconds = Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1_000));
  headers.set('retry-after', String(retryAfterSeconds));
  let body = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      body = JSON.stringify({
        ...record,
        ...(error && typeof error === 'object' && !Array.isArray(error)
          ? { error: { ...(error as Record<string, unknown>), retryAt } }
          : { retryAt }),
      });
      headers.delete('content-length');
    }
  } catch {
    // 非 JSON 错误体保持原文，仅通过 Retry-After 暴露冷却时间。
  }
  return {
    ...result,
    response: new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers,
    }),
  };
}

async function cancelQuotaResponse(lastQuota: LastQuota | undefined): Promise<void> {
  if (lastQuota?.kind !== 'response') return;
  await lastQuota.result.response.body?.cancel().catch(() => undefined);
}
