#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const component = z.enum(['web', 'api', 'runtimeWorker', 'acs']);

const integrationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    task: z
      .object({
        id: z.uuid(),
        revision: z.number().int().positive(),
        status: z.literal('merged'),
      })
      .strict(),
    finalPullRequest: z
      .object({
        number: z.number().int().positive(),
        headSha: sha,
        mergeCommitOid: sha,
        state: z.literal('MERGED'),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            headSha: sha,
            state: z.literal('MERGED'),
            reviewedSubjectDigest: digest,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const checksSchema = z
  .object({
    appCi: z
      .object({
        workflow: z.literal('Build & Check'),
        status: z.literal('success'),
        headSha: sha,
        runId: z.number().int().positive(),
      })
      .strict(),
    acsImpact: z
      .object({
        workflow: z.literal('ACS Impact Gate'),
        status: z.enum(['success', 'not_required']),
        headSha: sha,
        runId: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

const productionStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.literal('production'),
    digest,
    components: z
      .object({
        web: z.object({ gitSha: sha, artifactDigest: digest }).passthrough(),
        api: z.object({ gitSha: sha, artifactDigest: digest }).passthrough(),
        runtimeWorker: z.object({ gitSha: sha, artifactDigest: digest }).passthrough(),
        acs: z
          .object({
            gitSha: sha,
            orchestratorArtifactDigest: digest,
            sandboxImageDigest: digest,
          })
          .passthrough(),
      })
      .strict(),
  })
  .passthrough();

const artifactSchema = z
  .object({
    uri: z.string().url(),
    digest,
    size: z.number().int().positive(),
  })
  .strict();
const baselineArtifactsSchema = z
  .object({
    serverBundle: artifactSchema,
    webAssets: artifactSchema,
    acsOrchestrator: artifactSchema,
    acsImage: z.object({ repository: z.string().min(1), digest }).strict(),
  })
  .strict();

const classificationSchema = z
  .object({
    ok: z.literal(true),
    changedFiles: z.array(z.string()),
    components: z.array(component),
    blockingReasons: z.array(z.never()).max(0),
  })
  .strict();

const migrationSchema = z
  .object({
    ok: z.literal(true),
    migrationPlan: z
      .object({
        phase: z.enum(['none', 'expand']),
        planDigest: digest,
        confirmation: z.enum(['not_required', 'required_after_observation']),
        contract: z.literal('separate_release'),
      })
      .strict(),
    blockingReasons: z.array(z.never()).max(0),
  })
  .strict();

const compatibilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseSha: sha,
    productionBaselineDigest: digest,
    affectedComponents: z.array(component),
    status: z.enum(['compatible', 'not_required']),
    executedAt: z.string().datetime({ offset: true }),
    checks: z.array(
      z
        .object({
          name: z.string().min(1),
          status: z.literal('passed'),
          evidenceUri: z.string().url(),
        })
        .strict(),
    ),
  })
  .strict();

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

async function readJson(path, schema, label) {
  const parsed = schema.safeParse(JSON.parse(await readFile(resolve(path), 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${label} is invalid at ${issue.path.join('.')}: ${issue.message}`);
  }
  return parsed.data;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

export async function produceReleaseEvidence(options) {
  const releaseSha = String(options.sha ?? '');
  if (!sha.safeParse(releaseSha).success) throw new Error('--sha must be a complete SHA');
  const integration = await readJson(
    options.integration,
    integrationSnapshotSchema,
    'Integration snapshot',
  );
  const checks = await readJson(options.checks, checksSchema, 'GitHub checks');
  const production = await readJson(options.production, productionStateSchema, 'Production state');
  const baselineArtifacts = await readJson(
    options['baseline-artifacts'],
    baselineArtifactsSchema,
    'Baseline artifacts',
  );
  const classification = await readJson(
    options.classification,
    classificationSchema,
    'Release classification',
  );
  const migration = await readJson(options.migration, migrationSchema, 'Migration plan');
  const compatibility = await readJson(
    options.compatibility,
    compatibilitySchema,
    'Compatibility report',
  );

  if (integration.finalPullRequest.mergeCommitOid !== releaseSha)
    throw new Error('Final Integration PR merge commit does not equal the release SHA');
  if (checks.appCi.headSha !== releaseSha || checks.acsImpact.headSha !== releaseSha)
    throw new Error('GitHub checks are not bound to the release SHA');
  if ((checks.acsImpact.status === 'success') !== (checks.acsImpact.runId !== undefined)) {
    throw new Error('ACS Impact Gate run ID is inconsistent with its status');
  }
  const sourcePullRequests = integration.sources
    .map((source) => source.number)
    .sort((a, b) => a - b);
  assertUnique(sourcePullRequests, 'Integration source pull requests');
  if (sourcePullRequests.includes(integration.finalPullRequest.number))
    throw new Error('Final Integration PR cannot also be a source PR');
  assertUnique(classification.components, 'Affected components');
  if (
    compatibility.releaseSha !== releaseSha ||
    compatibility.productionBaselineDigest !== production.digest ||
    canonicalJson(compatibility.affectedComponents) !== canonicalJson(classification.components)
  ) {
    throw new Error('Compatibility report is not bound to this release and production baseline');
  }
  if (classification.components.length === 0) {
    if (compatibility.status !== 'not_required' || compatibility.checks.length !== 0)
      throw new Error(
        'A governance-only release must use an empty not_required compatibility report',
      );
  } else if (compatibility.status !== 'compatible' || compatibility.checks.length === 0) {
    throw new Error('A runtime release requires passed N/N+1 compatibility checks');
  }

  const productionBaseline = {
    web: {
      sourceSha: production.components.web.gitSha,
      artifactDigest: production.components.web.artifactDigest,
    },
    api: {
      sourceSha: production.components.api.gitSha,
      artifactDigest: production.components.api.artifactDigest,
    },
    runtimeWorker: {
      sourceSha: production.components.runtimeWorker.gitSha,
      artifactDigest: production.components.runtimeWorker.artifactDigest,
    },
    acs: {
      sourceSha: production.components.acs.gitSha,
      orchestratorArtifactDigest: production.components.acs.orchestratorArtifactDigest,
      sandboxImageDigest: production.components.acs.sandboxImageDigest,
    },
  };
  const integrationReceiptBody = {
    schemaVersion: 1,
    task: integration.task,
    finalPullRequest: integration.finalPullRequest,
    sources: [...integration.sources].sort((left, right) => left.number - right.number),
  };
  const body = {
    schemaVersion: 1,
    ok: true,
    releaseSha,
    compatibilityEvidenceDigest: digestBuffer(Buffer.from(canonicalJson(compatibility))),
    productionBaselineStatus: 'known',
    integrationCandidates: [
      {
        candidateId: integration.task.id,
        revision: integration.task.revision,
        mergedCommitOid: integration.finalPullRequest.mergeCommitOid,
      },
    ],
    sourcePullRequests,
    checks: {
      appCi: {
        status: 'success',
        headSha: checks.appCi.headSha,
        runId: checks.appCi.runId,
      },
      acsImpact: {
        status: checks.acsImpact.status,
        headSha: checks.acsImpact.headSha,
        ...(checks.acsImpact.runId ? { runId: checks.acsImpact.runId } : {}),
      },
      integrationReceipt: {
        status: 'success',
        subjectDigest: digestBuffer(Buffer.from(canonicalJson(integrationReceiptBody))),
      },
    },
    productionBaseline,
    baselineArtifacts,
    affectedComponents: classification.components,
    migrationPlan: migration.migrationPlan,
  };
  const evidence = validateReleaseEvidenceDocument(
    { ...body, evidenceDigest: digestBuffer(Buffer.from(canonicalJson(body))) },
    { expectedSha: releaseSha },
  );
  await writeFile(resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o444,
  });
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  produceReleaseEvidence(parse(process.argv)).then((value) =>
    process.stdout.write(`${value.evidenceDigest}\n`),
  );
}
