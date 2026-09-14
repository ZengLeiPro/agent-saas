import type { KyAppConfig } from '../config/index.js';
import type { JwksClient } from '../jwks/client.js';
import type { JtiStore } from '../sat/jtiStore.js';
import { verifySat } from '../sat/verify.js';
import type { EnrollmentChallengeInput, PlatformChallengeVerifier } from './types.js';

/**
 * enrollment challenge 使用平台短期 SAT，复用成熟的 ES256/JWKS、claim 矩阵、时钟和 jti 消费。
 * 通过一个仅用于验证的瞬时配置绑定 iid/tid/sid/issuer，不读取任何 V1 安装秘密。
 */
export class SatPlatformChallengeVerifier implements PlatformChallengeVerifier {
  constructor(
    private readonly options: { jwks: JwksClient; jtiStore: JtiStore; now?: () => number },
  ) {}

  async verify(token: string, input: EnrollmentChallengeInput): Promise<void> {
    const config: KyAppConfig = {
      env: 'test',
      systemId: input.systemId,
      tenantId: input.tenantId,
      installationId: input.installationId,
      origin: input.origin,
      serviceCredential: '',
      issuer: input.platformIssuer,
      jwksUrl: 'https://invalid.local/.well-known/jwks.json',
      installationKey: new Uint8Array(32),
      installationKeyVersion: 'not-used-by-v2',
      localLoginEnabled: false,
    };
    const identity = await verifySat(token, {
      config,
      jwks: this.options.jwks,
      jtiStore: this.options.jtiStore,
      request: { method: 'GET', pathname: '/ky/v1/manifest', requestId: input.operationId },
      pathPrefixes: { user: [], admin: [] },
      manifestDigest: '0'.repeat(64),
      now: this.options.now,
    });
    if (identity.act !== 'platform') throw new Error('challenge_requires_platform_sat');
  }
}
