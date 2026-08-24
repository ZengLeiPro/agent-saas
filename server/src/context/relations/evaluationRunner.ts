import { z } from 'zod';

import {
  assessRelationWalkIncrement,
  evaluateRelationVariants,
  type RelationEvaluationCase,
  type RelationWalkIncrementThresholds,
} from './evaluator.js';

const variantNumberSchema = z.object({
  A: z.number().nonnegative().optional(),
  B: z.number().nonnegative().optional(),
  C: z.number().nonnegative().optional(),
}).strict();
const variantBooleanSchema = z.object({
  A: z.boolean().optional(), B: z.boolean().optional(), C: z.boolean().optional(),
}).strict();
const observationSchema = z.object({
  citationValid: z.number().nonnegative().optional(),
  citationTotal: z.number().nonnegative().optional(),
  followupRequired: z.boolean().optional(),
  latencyMs: z.number().nonnegative().optional(),
  aclLeaks: z.number().int().nonnegative().optional(),
}).strict();
const observationsSchema = z.object({
  A: observationSchema.optional(), B: observationSchema.optional(), C: observationSchema.optional(),
}).strict();
const thresholdsSchema = z.object({
  minRecallGain: z.number().min(0).max(1).optional(),
  minFollowupReduction: z.number().min(0).max(1).optional(),
  maxCitationPrecisionDrop: z.number().min(0).max(1).optional(),
}).strict();
const evaluationCaseSchema = z.object({
  caseId: z.string().min(1).max(200),
  relevantEntityIds: z.array(z.string().min(1).max(500)).min(1).max(1_000),
  candidates: z.object({
    A: z.array(z.string().min(1).max(500)),
    B: z.array(z.string().min(1).max(500)),
    C: z.array(z.string().min(1).max(500)),
  }).strict(),
  citationValid: variantNumberSchema.optional(),
  citationTotal: variantNumberSchema.optional(),
  followupRequired: variantBooleanSchema.optional(),
  latencyMs: variantNumberSchema.optional(),
  aclLeaks: variantNumberSchema.optional(),
  observations: observationsSchema.optional(),
}).strict();
export const relationEvaluationDatasetSchema = z.object({
  version: z.literal(1),
  maxCandidatesPerVariant: z.number().int().min(1).max(1_000).default(200),
  thresholds: thresholdsSchema.optional(),
  cases: z.array(evaluationCaseSchema).min(1).max(10_000),
}).strict();

export interface RelationEvaluationReport {
  version: 1;
  datasetSha256: string;
  caseCount: number;
  maxCandidatesPerVariant: number;
  thresholds: Partial<RelationWalkIncrementThresholds>;
  metrics: ReturnType<typeof evaluateRelationVariants>;
  relationWalkAssessment: ReturnType<typeof assessRelationWalkIncrement>;
  passed: boolean;
}

export function runRelationEvaluation(raw: unknown, datasetSha256: string): RelationEvaluationReport {
  if (!/^[a-f0-9]{64}$/.test(datasetSha256)) throw new Error('datasetSha256 must be a lowercase SHA-256 hex digest');
  const dataset = relationEvaluationDatasetSchema.parse(raw);
  const caseIds = new Set<string>();
  for (const item of dataset.cases) {
    if (caseIds.has(item.caseId)) throw new Error(`duplicate caseId: ${item.caseId}`);
    caseIds.add(item.caseId);
    for (const variant of ['A', 'B', 'C'] as const) {
      if (item.candidates[variant].length > dataset.maxCandidatesPerVariant) {
        throw new Error(`${item.caseId} variant ${variant} exceeds maxCandidatesPerVariant`);
      }
      const valid = item.observations?.[variant]?.citationValid ?? item.citationValid?.[variant];
      const total = item.observations?.[variant]?.citationTotal ?? item.citationTotal?.[variant];
      if (valid !== undefined && total !== undefined && valid > total) {
        throw new Error(`${item.caseId} variant ${variant} citationValid exceeds citationTotal`);
      }
    }
  }
  const cases = dataset.cases as RelationEvaluationCase[];
  const metrics = evaluateRelationVariants(cases);
  const relationWalkAssessment = assessRelationWalkIncrement(metrics, dataset.thresholds);
  return {
    version: 1,
    datasetSha256,
    caseCount: cases.length,
    maxCandidatesPerVariant: dataset.maxCandidatesPerVariant,
    thresholds: dataset.thresholds ?? {},
    metrics,
    relationWalkAssessment,
    passed: relationWalkAssessment.eligible,
  };
}
