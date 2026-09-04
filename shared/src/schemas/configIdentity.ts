import { z } from 'zod';

/**
 * Release-bound Config Identity 契约（TASK-318）。
 *
 * 目标：用一个版本化、跨 App / Worker / Web / ACS 一致的表达，分别描述
 * 「Release 期望的配置身份」与「Runtime 实际观察到的配置身份」，让平台管理员
 * 能在产品内判断二者是一致、漂移、不可验证还是未采集。
 *
 * 本文件只承载 *跨进程 wire 契约*（状态词、digest 形态、只读摘要 schema）；
 * canonical projection 与 digest 计算本身在 server 侧
 * `server/src/release/configIdentity.ts` 实现（需要 AppConfig 类型）。
 * 所有字段都必须是非敏感的：digest、计数、时间戳与状态，不允许出现
 * secret 明文、可逆密文、连接串或本机绝对路径。
 */

/** digest 形态：与 Release Manifest digest 一致的 sha256 hex。 */
export const CONFIG_IDENTITY_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** 当前契约版本。projection 语义变化时必须递增并显式迁移，不允许静默改语义。 */
export const CONFIG_IDENTITY_SCHEMA_VERSION = 1 as const;

/**
 * 四态判定词汇（全组件共用，禁止各写一套同义词）：
 * - consistent  ：expected 与 observed digest 一致且凭据版本可验证。
 * - drifted     ：expected 与 observed 不一致（配置热更新、凭据轮换或错配）。
 * - unverifiable：身份已采集但不足以做一致性判定（expected 未绑定、
 *                 SecretVault ref 版本不可解析、观察值不完整等）。
 * - not_collected：Runtime 尚未采集 observed identity（刚启动或未接入）。
 */
export const configIdentityStatusSchema = z.enum([
  'consistent',
  'drifted',
  'unverifiable',
  'not_collected',
]);
export type ConfigIdentityStatus = z.infer<typeof configIdentityStatusSchema>;

/** Secret ref 版本解析结果（只描述解析能力，不携带任何凭据信息）。 */
export const configIdentityVersionResolutionSchema = z.enum(['resolved', 'partial', 'unavailable']);
export type ConfigIdentityVersionResolution = z.infer<typeof configIdentityVersionResolutionSchema>;

/** 不可验证原因（机器可读，供 evidence / 测试断言；文本渲染由前端负责）。 */
export const configIdentityUnverifiableReasonSchema = z.enum([
  'expected_not_bound',
  'expected_credential_version_not_bound',
  'secret_ref_version_unresolved',
  'schema_version_unsupported',
]);
export type ConfigIdentityUnverifiableReason = z.infer<
  typeof configIdentityUnverifiableReasonSchema
>;

const digestSchema = z.string().regex(CONFIG_IDENTITY_DIGEST_PATTERN);

/** 单侧身份摘要：digest 是可比较的配置语义摘要；credentialVersionDigest 是凭据版本摘要。 */
export const configIdentitySideSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    digest: digestSchema,
    /** 覆盖受管 SecretVault ref 的 opaque version/rotation 摘要；解析成功才有。 */
    credentialVersionDigest: digestSchema.optional(),
  })
  .strict();
export type ConfigIdentitySide = z.infer<typeof configIdentitySideSchema>;

/**
 * 只读、脱敏的配置身份摘要。进入 overview snapshot / healthz ready /
 * production state / evidence 的都是这个形态。
 */
export const configIdentitySummarySchema = z
  .object({
    schemaVersion: z.literal(CONFIG_IDENTITY_SCHEMA_VERSION),
    status: configIdentityStatusSchema,
    reason: configIdentityUnverifiableReasonSchema.optional(),
    expected: configIdentitySideSchema.optional(),
    observed: z
      .object({
        schemaVersion: z.number().int().positive(),
        digest: digestSchema,
        credentialVersionDigest: digestSchema.nullable(),
        versionResolution: configIdentityVersionResolutionSchema,
        /** 受管 SecretVault ref 计数（不含 ref id 本身）。 */
        secretRefCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    releaseId: z.string().min(1).optional(),
    firstObservedAt: z.string().min(1).optional(),
    lastObservedAt: z.string().min(1).optional(),
    lastChangedAt: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === 'consistent' || value.status === 'drifted') && !value.expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['expected'],
        message: `${value.status} requires expected`,
      });
    }
    if ((value.status === 'consistent' || value.status === 'drifted') && !value.observed) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed'],
        message: `${value.status} requires observed`,
      });
    }
    if (value.status === 'unverifiable' && !value.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'unverifiable requires reason' });
    }
    if (value.status === 'unverifiable' && !value.observed) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed'],
        message: 'unverifiable requires observed',
      });
    }
    if (value.status !== 'unverifiable' && value.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is only valid for unverifiable',
      });
    }
    if (value.status === 'unverifiable' && value.reason) {
      // 原因必须服从 evaluator 的优先级：缺 binding、schema、config drift、版本解析。
      const reasonMatches =
        (value.reason === 'expected_not_bound' && !value.expected && Boolean(value.observed)) ||
        (value.reason === 'secret_ref_version_unresolved' &&
          Boolean(value.expected) &&
          Boolean(value.observed) &&
          value.expected?.schemaVersion === value.schemaVersion &&
          value.observed?.schemaVersion === value.schemaVersion &&
          value.expected?.digest === value.observed?.digest &&
          value.observed?.versionResolution !== 'resolved') ||
        (value.reason === 'expected_credential_version_not_bound' &&
          Boolean(value.expected) &&
          Boolean(value.observed) &&
          value.expected?.schemaVersion === value.schemaVersion &&
          value.observed?.schemaVersion === value.schemaVersion &&
          value.expected?.digest === value.observed?.digest &&
          value.expected?.credentialVersionDigest === undefined &&
          value.observed?.versionResolution === 'resolved' &&
          value.observed.secretRefCount > 0 &&
          value.observed.credentialVersionDigest !== null) ||
        (value.reason === 'schema_version_unsupported' &&
          Boolean(value.expected) &&
          Boolean(value.observed) &&
          (value.expected?.schemaVersion !== value.schemaVersion ||
            value.observed?.schemaVersion !== value.schemaVersion));
      if (!reasonMatches) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'unverifiable reason conflicts with expected/observed identity',
        });
      }
    }
    if (value.status === 'not_collected' && value.observed) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed'],
        message: 'not_collected must not include observed',
      });
    }
    if (value.observed) {
      const hasCredentialDigest = value.observed.credentialVersionDigest !== null;
      const invalidResolutionShape =
        (value.observed.versionResolution === 'resolved' &&
          hasCredentialDigest !== value.observed.secretRefCount > 0) ||
        (value.observed.versionResolution === 'partial' &&
          (!hasCredentialDigest || value.observed.secretRefCount === 0)) ||
        (value.observed.versionResolution === 'unavailable' &&
          (hasCredentialDigest || value.observed.secretRefCount === 0));
      if (invalidResolutionShape) {
        ctx.addIssue({
          code: 'custom',
          path: ['observed', 'versionResolution'],
          message: 'observed credential digest/count conflicts with versionResolution',
        });
      }
    }
    if (
      (value.status === 'consistent' || value.status === 'drifted') &&
      value.expected &&
      value.observed
    ) {
      if (
        value.expected.schemaVersion !== value.schemaVersion ||
        value.observed.schemaVersion !== value.schemaVersion
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: `${value.status} requires supported side schema versions`,
        });
      }
      const credentialBindingMissing =
        value.observed.secretRefCount > 0 &&
        value.expected.credentialVersionDigest === undefined;
      const credentialDiffers =
        value.expected.credentialVersionDigest !== undefined &&
        value.expected.credentialVersionDigest !== value.observed.credentialVersionDigest;
      if (
        value.status === 'consistent' &&
        (value.expected.digest !== value.observed.digest ||
          value.observed.versionResolution !== 'resolved' ||
          credentialBindingMissing ||
          credentialDiffers)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'consistent conflicts with expected/observed identity',
        });
      }
      if (
        value.status === 'drifted' &&
        value.expected.digest === value.observed.digest &&
        (value.observed.versionResolution !== 'resolved' || !credentialDiffers)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'drifted requires a config or resolved credential version mismatch',
        });
      }
    }
  });
export type ConfigIdentitySummary = z.infer<typeof configIdentitySummarySchema>;

/** 对 summary 做 wire 校验（防止旧 schema / 缺字段数据被当成正常值渲染）。 */
export function parseConfigIdentitySummary(value: unknown): ConfigIdentitySummary | null {
  const parsed = configIdentitySummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
