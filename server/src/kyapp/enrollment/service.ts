import { randomBytes } from 'node:crypto';

import {
  V2_CALLBACK_PATH,
  V2_SCOPES,
  V2_TTL_SECONDS,
  V2ContractError,
  decodeV2Jws,
  sha256Hex,
  verifyEnrollmentRequest,
  verifyPkceS256,
} from '@kaiyan/ky-app-contract';

import type { KyAppPlatformConfig } from '../config.js';
import type { KyAppSystemStore } from '../systems/types.js';
import type { KyAppV2Authenticator } from '../workload/authenticator.js';
import type { PgDeploymentKeyStore } from '../workload/deploymentKeyStore.js';
import type { KyAppV2TokenIssuer } from '../workload/tokenIssuer.js';
import { EnrollmentStoreError, type PgEnrollmentStore } from './store.js';
import type { EnrollmentOperation } from './types.js';

export class EnrollmentServiceError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'EnrollmentServiceError';
  }
}

export class KyAppEnrollmentService {
  private readonly now: () => number;

  constructor(
    private readonly options: {
      config: KyAppPlatformConfig;
      systems: KyAppSystemStore;
      operations: PgEnrollmentStore;
      deploymentKeys: PgDeploymentKeyStore;
      authenticator: KyAppV2Authenticator;
      tokens: KyAppV2TokenIssuer;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  async create(input: {
    operationId: string;
    installationId: string;
    actorUserId: string;
  }): Promise<{ operation: EnrollmentOperation; created: boolean }> {
    const installation = await this.requireEligibleInstallation(input.installationId);
    const requestDigest = sha256Hex(
      JSON.stringify({
        operationId: input.operationId,
        installationId: input.installationId,
        actorUserId: input.actorUserId,
        systemId: installation.systemId,
      }),
    );
    return this.options.operations.createOrGet({ ...input, requestDigest });
  }

  async getOperation(operationId: string): Promise<EnrollmentOperation> {
    return this.requireOperation(operationId);
  }

  async acceptChallenge(input: {
    operationId: string;
    nonce: string;
    callbackState: string;
    enrollmentRequest: string;
  }): Promise<EnrollmentOperation> {
    const operation = await this.requireOperation(input.operationId);
    const installation = await this.requireEligibleInstallation(operation.installationId);
    const decoded = decodeV2Jws(input.enrollmentRequest);
    const deploymentId = decoded.payload.deployment_id;
    if (typeof deploymentId !== 'string') {
      throw new EnrollmentServiceError('enrollment request 缺少 deploymentId', 'invalid_claims');
    }
    const result = verifyEnrollmentRequest(input.enrollmentRequest, {
      platformIssuer: this.options.config.issuer,
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      deploymentId,
      origin: installation.origin,
      callbackUrl: `${installation.origin}${V2_CALLBACK_PATH}`,
      nonce: input.nonce,
      now: Math.floor(this.now() / 1000),
    });
    const invalidScope = result.claims.scope.find(
      (scope) => !(V2_SCOPES as readonly string[]).includes(scope),
    );
    if (invalidScope) {
      throw new EnrollmentServiceError(`请求了未登记 scope ${invalidScope}`, 'insufficient_scope');
    }
    return this.options.operations.recordChallenge(input.operationId, {
      deploymentId,
      keyId: result.keyId,
      publicJwk: result.claims.public_jwk,
      origin: result.claims.origin,
      callbackUrl: result.claims.callback_uri,
      callbackState: input.callbackState,
      pkceChallenge: result.claims.code_challenge,
      scopes: result.claims.scope,
    });
  }

  async approve(input: {
    operationId: string;
    actorUserId: string;
    reauthenticated: boolean;
  }): Promise<{
    code: string;
    callbackUrl: string;
    state: string;
    operation: EnrollmentOperation;
  }> {
    if (!input.reauthenticated) {
      throw new EnrollmentServiceError('批准前必须重新认证', 'reauthentication_required');
    }
    const current = await this.requireOperation(input.operationId);
    if (current.actorUserId !== input.actorUserId) {
      throw new EnrollmentServiceError('只有原操作者可以批准', 'forbidden');
    }
    if (!current.callbackUrl || !current.callbackState) {
      throw new EnrollmentServiceError('challenge 尚未完成', 'invalid_state');
    }
    const code = randomBytes(32).toString('base64url');
    const operation = await this.options.operations.issueCode({
      operationId: input.operationId,
      actorUserId: input.actorUserId,
      codeSha256: sha256Hex(code),
      expiresAt: new Date(this.now() + V2_TTL_SECONDS.authorizationCode * 1000),
    });
    return {
      code,
      callbackUrl: current.callbackUrl,
      state: current.callbackState,
      operation,
    };
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    clientAssertion: string;
    dpopProof: string;
  }): Promise<{
    installationGrant: string;
    accessToken: string;
    tokenType: 'DPoP';
    expiresIn: number;
    installationId: string;
  }> {
    if (!this.options.config.enrollmentV2.issueWorkloadTokens) {
      throw new EnrollmentServiceError('V2 token 签发尚未开启', 'feature_disabled');
    }
    const codeSha256 = sha256Hex(input.code);
    const operation = await this.options.operations.getByCodeHash(codeSha256);
    if (
      !operation ||
      !operation.deploymentId ||
      !operation.keyId ||
      !operation.publicJwk ||
      !operation.pkceChallenge
    ) {
      throw new EnrollmentServiceError('授权码无对应 operation', 'authorization_code_invalid');
    }
    verifyPkceS256(input.codeVerifier, operation.pkceChallenge);
    const replayReadback = operation.codeConsumedAt !== null;
    const proof = await this.options.authenticator.authenticateTokenRequest({
      installationId: operation.installationId,
      deploymentId: operation.deploymentId,
      keyId: operation.keyId,
      publicJwk: operation.publicJwk,
      clientAssertion: input.clientAssertion,
      dpopProof: input.dpopProof,
      reserveReplay: !replayReadback,
    });
    if (
      replayReadback &&
      (operation.result.assertionJti !== proof.assertionJti ||
        operation.result.dpopJti !== proof.dpopJti)
    ) {
      throw new EnrollmentServiceError(
        '已提交兑换只能用原 proof 查询',
        'authorization_code_replayed',
      );
    }
    const installation = await this.requireEligibleInstallation(operation.installationId);
    const definition = await this.options.systems.getDefinition(installation.systemId);
    if (!definition?.publishedDigest) {
      throw new EnrollmentServiceError('系统没有已发布版本', 'system_not_published');
    }
    const grantJti = operation.grantJti ?? randomBytes(16).toString('base64url');
    const committed = await this.options.operations.commitExchange({
      codeSha256,
      now: new Date(this.now()),
      deploymentId: operation.deploymentId,
      keyId: operation.keyId,
      grantJti,
      result: {
        installationId: operation.installationId,
        generation: 1,
        registeredDigest: definition.publishedDigest,
        assertionJti: proof.assertionJti,
        dpopJti: proof.dpopJti,
      },
    });
    const bound = await this.options.systems.getInstallation(operation.installationId);
    if (!bound) throw new EnrollmentServiceError('绑定后安装实例不可读', 'operation_conflict');
    const [grant, workload] = await Promise.all([
      this.options.tokens.issueInstallationGrant({
        installation: bound,
        deploymentId: operation.deploymentId,
        keyId: operation.keyId,
        scopes: committed.operation.grantedScopes,
        generation: 1,
        registeredDigest: definition.publishedDigest,
        grantJti: committed.operation.grantJti ?? grantJti,
      }),
      this.options.tokens.issueWorkloadToken({
        installation: bound,
        deploymentId: operation.deploymentId,
        keyId: operation.keyId,
        scopes: ['installation.activate'],
        generation: 1,
      }),
    ]);
    return {
      installationGrant: grant.token,
      accessToken: workload.token,
      tokenType: 'DPoP',
      expiresIn: V2_TTL_SECONDS.workloadAccessToken,
      installationId: operation.installationId,
    };
  }

  async issueClientCredentials(input: {
    installationId: string;
    clientAssertion: string;
    dpopProof: string;
    scopes: string[];
  }): Promise<{ accessToken: string; tokenType: 'DPoP'; expiresIn: number }> {
    if (!this.options.config.enrollmentV2.issueWorkloadTokens) {
      throw new EnrollmentServiceError('V2 token 签发尚未开启', 'feature_disabled');
    }
    const installation = await this.requireV2Installation(input.installationId);
    const decodedAssertion = decodeV2Jws(input.clientAssertion);
    const assertedKeyId = decodedAssertion.protectedHeader.kid;
    if (typeof assertedKeyId !== 'string') {
      throw new EnrollmentServiceError('client assertion 缺少 kid', 'invalid_claims');
    }
    const key = (
      await this.options.deploymentKeys.listAccepted(input.installationId, new Date(this.now()))
    ).find(
      (candidate) =>
        candidate.status !== 'next' &&
        candidate.keyId === assertedKeyId &&
        candidate.deploymentId === installation.deploymentId,
    );
    if (!key) {
      throw new EnrollmentServiceError('部署公钥不可用或已超过轮换窗口', 'key_id_mismatch');
    }
    const enrollment = await this.options.operations.getLatestExchanged(input.installationId);
    if (!enrollment) {
      throw new EnrollmentServiceError('找不到已完成的安装授权', 'installation_inactive');
    }
    const scopes = [...new Set(input.scopes)].sort();
    if (
      scopes.length === 0 ||
      scopes.some(
        (scope) =>
          !(V2_SCOPES as readonly string[]).includes(scope) ||
          !enrollment.grantedScopes.includes(scope),
      )
    ) {
      throw new EnrollmentServiceError('请求权限超出安装授权范围', 'insufficient_scope');
    }
    await this.options.authenticator.authenticateTokenRequest({
      installationId: installation.installationId,
      deploymentId: key.deploymentId,
      keyId: key.keyId,
      publicJwk: key.publicJwk,
      clientAssertion: input.clientAssertion,
      dpopProof: input.dpopProof,
    });
    const token = await this.options.tokens.issueWorkloadToken({
      installation,
      deploymentId: key.deploymentId,
      keyId: key.keyId,
      scopes,
      generation: key.generation,
    });
    return {
      accessToken: token.token,
      tokenType: 'DPoP',
      expiresIn: V2_TTL_SECONDS.workloadAccessToken,
    };
  }

  private async requireOperation(operationId: string): Promise<EnrollmentOperation> {
    const operation = await this.options.operations.get(operationId);
    if (!operation)
      throw new EnrollmentServiceError('授权 operation 不存在', 'operation_not_found');
    return operation;
  }

  private async requireEligibleInstallation(installationId: string) {
    const installation = await this.options.systems.getInstallation(installationId);
    if (!installation || installation.status === 'deleted') {
      throw new EnrollmentServiceError('安装实例不存在', 'installation_not_found');
    }
    if (!this.options.config.enrollmentV2.enabled) {
      throw new EnrollmentServiceError('V2 enrollment 未开启', 'feature_disabled');
    }
    if (!this.options.config.enrollmentV2.allowedSystemIds.includes(installation.systemId)) {
      throw new EnrollmentServiceError('系统不在 V2 allowlist', 'feature_disabled');
    }
    if (!installation.domainVerifiedAt) {
      throw new EnrollmentServiceError('业务域名尚未验证', 'origin_not_verified');
    }
    return installation;
  }

  private async requireV2Installation(installationId: string) {
    const installation = await this.requireEligibleInstallation(installationId);
    if (
      installation.authMode !== 'v2_asymmetric' ||
      !installation.deploymentId ||
      !installation.currentKeyId ||
      !installation.identityGeneration ||
      (installation.status !== 'pending' && installation.status !== 'enabled')
    ) {
      throw new EnrollmentServiceError('安装实例不是已启用 V2 身份', 'installation_inactive');
    }
    return installation;
  }
}

export function enrollmentReason(error: unknown): string {
  if (error instanceof EnrollmentServiceError || error instanceof EnrollmentStoreError) {
    return error.reason;
  }
  if (error instanceof V2ContractError) return error.code;
  return 'internal';
}
