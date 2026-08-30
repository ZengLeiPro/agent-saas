import { z } from 'zod';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';

const releaseComponentSchema = z.enum(['web', 'api', 'runtimeWorker', 'acs']);
const fullShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/u, 'Expected a lowercase complete 40-character SHA');
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u, 'Expected a sha256 digest');

/**
 * TASK-318：只读脱敏配置身份摘要（与 server /api/healthz/ready 的
 * configIdentity 同构；strict 校验防止旧 schema/缺字段数据混入 evidence）。
 */
const configIdentitySideSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    digest: sha256DigestSchema,
    credentialVersionDigest: sha256DigestSchema.optional(),
  })
  .strict();
const configIdentitySummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(['consistent', 'drifted', 'unverifiable', 'not_collected']),
    reason: z
      .enum([
        'expected_not_bound',
        'observed_unavailable',
        'secret_ref_version_unresolved',
        'schema_version_unsupported',
      ])
      .optional(),
    expected: configIdentitySideSchema.optional(),
    observed: z
      .object({
        schemaVersion: z.number().int().positive(),
        digest: sha256DigestSchema,
        credentialVersionDigest: sha256DigestSchema.nullable(),
        versionResolution: z.enum(['resolved', 'partial', 'unavailable']),
        secretRefCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    releaseId: z.string().min(1),
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
    if (value.status !== 'unverifiable' && value.reason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is only valid for unverifiable',
      });
    }
    if (value.status === 'unverifiable' && value.reason) {
      const reasonMatches =
        (value.reason === 'expected_not_bound' && !value.expected && Boolean(value.observed)) ||
        (value.reason === 'observed_unavailable' && !value.observed) ||
        (value.reason === 'secret_ref_version_unresolved' &&
          Boolean(value.observed) &&
          value.observed?.versionResolution !== 'resolved') ||
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
          hasCredentialDigest !== (value.observed.secretRefCount > 0)) ||
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
      const credentialDiffers =
        value.expected.credentialVersionDigest !== undefined &&
        value.expected.credentialVersionDigest !== value.observed.credentialVersionDigest;
      if (
        value.expected.schemaVersion !== value.schemaVersion ||
        value.observed.schemaVersion !== value.schemaVersion ||
        (value.status === 'consistent' &&
          (value.expected.digest !== value.observed.digest ||
            value.observed.versionResolution !== 'resolved' ||
            credentialDiffers)) ||
        (value.status === 'drifted' &&
          value.expected.digest === value.observed.digest &&
          (value.observed.versionResolution !== 'resolved' || !credentialDiffers))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: `${value.status} conflicts with expected/observed identity`,
        });
      }
    }
  });

const artifactUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .superRefine((value, ctx) => {
    try {
      const uri = new URL(value);
      if (
        !['https:', 'oss:'].includes(uri.protocol) ||
        uri.username ||
        uri.password ||
        uri.search ||
        uri.hash
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Artifact URI must be an uncredentialed HTTPS or OSS URI',
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact URI must be absolute' });
    }
  });

const appIdentitySchema = z
  .object({ sourceSha: fullShaSchema, artifactDigest: sha256DigestSchema })
  .strict();
const acsIdentitySchema = z
  .object({
    sourceSha: fullShaSchema,
    orchestratorArtifactDigest: sha256DigestSchema,
    sandboxImageDigest: sha256DigestSchema,
  })
  .strict();
const productionBaselineSchema = z
  .object({
    web: appIdentitySchema,
    api: appIdentitySchema,
    runtimeWorker: appIdentitySchema,
    acs: acsIdentitySchema,
  })
  .strict();

const fileArtifactSchema = z
  .object({
    uri: artifactUriSchema,
    digest: sha256DigestSchema,
    size: z.number().int().positive(),
  })
  .strict();
const baselineArtifactsSchema = z
  .object({
    serverBundle: fileArtifactSchema,
    webAssets: fileArtifactSchema,
    acsOrchestrator: fileArtifactSchema,
    acsImage: z
      .object({
        repository: z.string().trim().min(1).max(512),
        digest: sha256DigestSchema,
      })
      .strict(),
  })
  .strict();

const integrationCandidateSchema = z
  .object({
    candidateId: z.uuid(),
    revision: z.number().int().positive(),
    mergedCommitOid: fullShaSchema,
  })
  .strict();
const releasePullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    headSha: fullShaSchema,
    mergeCommitOid: fullShaSchema,
    state: z.literal('MERGED'),
  })
  .strict();
const receiptSchema = z
  .object({
    status: z.literal('success'),
    subjectDigest: sha256DigestSchema,
  })
  .strict();
const appCiSchema = z
  .object({
    status: z.literal('success'),
    headSha: fullShaSchema,
    runId: z.number().int().positive(),
  })
  .strict();
const acsImpactSchema = z
  .object({
    status: z.enum(['success', 'not_required']),
    headSha: fullShaSchema,
    runId: z.number().int().positive().optional(),
  })
  .strict();

export const releaseEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    releaseSha: fullShaSchema,
    evidenceDigest: sha256DigestSchema,
    compatibilityEvidenceDigest: sha256DigestSchema.optional(),
    productionBaselineStatus: z.literal('known'),
    releasePullRequest: releasePullRequestSchema.optional(),
    integrationCandidates: z.array(integrationCandidateSchema).max(1_000),
    sourcePullRequests: z.array(z.number().int().positive()).min(1).max(1_000),
    checks: z
      .object({
        appCi: appCiSchema,
        acsImpact: acsImpactSchema,
        mergeReceipt: receiptSchema.optional(),
        integrationReceipt: receiptSchema.optional(),
      })
      .strict(),
    productionBaseline: productionBaselineSchema,
    // TASK-318：结构化配置身份（可选；由 Production State 的 configIdentity 透传）。
    configIdentity: configIdentitySummarySchema.optional(),
    baselineArtifacts: baselineArtifactsSchema,
    affectedComponents: z.array(releaseComponentSchema).max(4),
    migrationPlan: z
      .object({
        phase: z.enum(['none', 'expand']),
        planDigest: sha256DigestSchema,
        confirmation: z.enum(['not_required', 'required_after_observation']),
        contract: z.literal('separate_release'),
      })
      .strict(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (!evidence.checks.mergeReceipt && !evidence.checks.integrationReceipt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: 'A GitHub merge receipt or legacy Integration receipt is required',
      });
    }
    if (evidence.releasePullRequest) {
      if (evidence.releasePullRequest.mergeCommitOid !== evidence.releaseSha) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['releasePullRequest', 'mergeCommitOid'],
          message: 'Release pull request mergeCommitOid must equal releaseSha',
        });
      }
      if (!evidence.sourcePullRequests.includes(evidence.releasePullRequest.number)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourcePullRequests'],
          message: 'sourcePullRequests must include the release pull request',
        });
      }
    } else if (evidence.integrationCandidates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['releasePullRequest'],
        message: 'Direct GitHub releases require releasePullRequest evidence',
      });
    }
    if (
      new Set(evidence.sourcePullRequests).size !== evidence.sourcePullRequests.length ||
      evidence.sourcePullRequests.some(
        (value, index, values) => index > 0 && value <= values[index - 1],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourcePullRequests'],
        message: 'sourcePullRequests must be unique and ascending',
      });
    }
    for (const [index, candidate] of evidence.integrationCandidates.entries()) {
      if (candidate.mergedCommitOid !== evidence.releaseSha) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['integrationCandidates', index, 'mergedCommitOid'],
          message: 'mergedCommitOid must equal releaseSha',
        });
      }
    }
    if (
      evidence.checks.appCi.headSha !== evidence.releaseSha ||
      evidence.checks.acsImpact.headSha !== evidence.releaseSha
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: 'check headSha values must equal releaseSha',
      });
    }
    if (
      (evidence.checks.acsImpact.status === 'success') !==
      (evidence.checks.acsImpact.runId !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks', 'acsImpact', 'runId'],
        message: 'ACS Impact success requires runId; not_required must not claim a run',
      });
    }
    if (new Set(evidence.affectedComponents).size !== evidence.affectedComponents.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['affectedComponents'],
        message: 'affectedComponents must be unique',
      });
    }
    const affected = new Set(evidence.affectedComponents);
    if (affected.has('api') !== affected.has('runtimeWorker')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['affectedComponents'],
        message: 'API and Runtime Worker must be affected together',
      });
    }
    if (
      evidence.productionBaseline.api.sourceSha !==
        evidence.productionBaseline.runtimeWorker.sourceSha ||
      evidence.productionBaseline.api.artifactDigest !==
        evidence.productionBaseline.runtimeWorker.artifactDigest
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productionBaseline', 'runtimeWorker'],
        message: 'Production API and Runtime Worker must share one sealed server release',
      });
    }
    const baselineBindings = [
      [
        evidence.baselineArtifacts.serverBundle.digest,
        evidence.productionBaseline.api.artifactDigest,
        'serverBundle',
      ],
      [
        evidence.baselineArtifacts.webAssets.digest,
        evidence.productionBaseline.web.artifactDigest,
        'webAssets',
      ],
      [
        evidence.baselineArtifacts.acsOrchestrator.digest,
        evidence.productionBaseline.acs.orchestratorArtifactDigest,
        'acsOrchestrator',
      ],
      [
        evidence.baselineArtifacts.acsImage.digest,
        evidence.productionBaseline.acs.sandboxImageDigest,
        'acsImage',
      ],
    ];
    for (const [artifactDigest, componentDigest, artifact] of baselineBindings) {
      if (artifactDigest !== componentDigest) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baselineArtifacts', artifact, 'digest'],
          message: 'Baseline artifact digest must equal the production component identity',
        });
      }
    }
    if (
      (evidence.migrationPlan.phase === 'none') !==
      (evidence.migrationPlan.confirmation === 'not_required')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['migrationPlan', 'confirmation'],
        message: 'Migration phase and confirmation are inconsistent',
      });
    }
  });

export function validateReleaseEvidenceDocument(value, { expectedSha } = {}) {
  if (expectedSha !== undefined && !fullShaSchema.safeParse(expectedSha).success) {
    throw new Error('Expected release evidence SHA is invalid');
  }
  const parsed = releaseEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`Release evidence schema is invalid${path}: ${issue?.message ?? 'unknown'}`);
  }
  if (expectedSha !== undefined && parsed.data.releaseSha !== expectedSha) {
    throw new Error('Release evidence is not bound to the requested complete SHA');
  }
  const { evidenceDigest, ...body } = parsed.data;
  const actual = digestBuffer(Buffer.from(canonicalJson(body)));
  if (evidenceDigest !== actual) throw new Error('Release evidence digest is invalid');
  return parsed.data;
}
