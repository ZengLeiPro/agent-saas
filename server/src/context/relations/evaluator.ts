export type RelationEvaluationVariant = 'A' | 'B' | 'C';

export interface RelationEvaluationObservation {
  citationValid?: number;
  citationTotal?: number;
  followupRequired?: boolean;
  latencyMs?: number;
  aclLeaks?: number;
}

export interface RelationEvaluationCase {
  caseId: string;
  relevantEntityIds: string[];
  candidates: Record<RelationEvaluationVariant, string[]>;
  citationValid?: Partial<Record<RelationEvaluationVariant, number>>;
  citationTotal?: Partial<Record<RelationEvaluationVariant, number>>;
  followupRequired?: Partial<Record<RelationEvaluationVariant, boolean>>;
  latencyMs?: Partial<Record<RelationEvaluationVariant, number>>;
  aclLeaks?: Partial<Record<RelationEvaluationVariant, number>>;
  observations?: Partial<Record<RelationEvaluationVariant, RelationEvaluationObservation>>;
}

export interface RelationVariantMetrics {
  variant: RelationEvaluationVariant;
  cases: number;
  /** Macro averages; aliases are retained for existing offline reports. */
  precision: number;
  recall: number;
  macroPrecision: number;
  macroRecall: number;
  mrr: number;
  hitRate: number;
  candidateCount: number;
  meanCandidateCount: number;
  citationPrecision: number;
  citationSamples: number;
  followupRate: number;
  followupSamples: number;
  p95LatencyMs: number;
  latencySamples: number;
  aclLeaks: number;
  aclAuditSamples: number;
}

export interface RelationWalkIncrementThresholds {
  minRecallGain: number;
  minFollowupReduction: number;
  maxCitationPrecisionDrop: number;
}

export type RelationWalkIncrementReason =
  | 'MISSING_VARIANT_METRICS'
  | 'INSUFFICIENT_SAMPLES'
  | 'INVALID_METRICS'
  | 'INVALID_THRESHOLDS'
  | 'RECALL_GAIN_BELOW_THRESHOLD'
  | 'FOLLOWUP_REDUCTION_BELOW_THRESHOLD'
  | 'CITATION_PRECISION_DROP_ABOVE_THRESHOLD'
  | 'ACL_LEAKS_DETECTED';

export interface RelationWalkIncrementAssessment {
  eligible: boolean;
  reasons: RelationWalkIncrementReason[];
}

const VARIANTS = ['A', 'B', 'C'] as const;
const DEFAULT_THRESHOLDS: RelationWalkIncrementThresholds = {
  minRecallGain: 0.05,
  minFollowupReduction: 0.10,
  maxCitationPrecisionDrop: 0.01,
};
const METRIC_EPSILON = 1e-12;

/** Pure offline A/B/C evaluator; it performs no reads, ACL checks, or mutation. */
export function evaluateRelationVariants(cases: readonly RelationEvaluationCase[]): RelationVariantMetrics[] {
  return VARIANTS.map(variant => evaluateVariant(cases, variant));
}

function evaluateVariant(
  cases: readonly RelationEvaluationCase[],
  variant: RelationEvaluationVariant,
): RelationVariantMetrics {
  let macroPrecision = 0;
  let macroRecall = 0;
  let reciprocalRank = 0;
  let hits = 0;
  let candidateCount = 0;
  let citationValid = 0;
  let citationTotal = 0;
  let citationSamples = 0;
  let followups = 0;
  let followupSamples = 0;
  let aclLeaks = 0;
  let aclAuditSamples = 0;
  const latencies: number[] = [];

  for (const item of cases) {
    const relevant = new Set(item.relevantEntityIds);
    const candidates = [...new Set(item.candidates[variant])];
    const truePositives = candidates.filter(value => relevant.has(value)).length;
    macroPrecision += candidates.length === 0 ? 0 : truePositives / candidates.length;
    macroRecall += relevant.size === 0 ? 0 : truePositives / relevant.size;
    const firstRelevantRank = candidates.findIndex(value => relevant.has(value));
    if (firstRelevantRank >= 0) {
      hits += 1;
      reciprocalRank += 1 / (firstRelevantRank + 1);
    }
    candidateCount += candidates.length;

    const observation = item.observations?.[variant];
    const rawCitationValid = observation?.citationValid ?? item.citationValid?.[variant];
    const rawCitationTotal = observation?.citationTotal ?? item.citationTotal?.[variant];
    const valid = nonNegative(rawCitationValid);
    const total = nonNegative(rawCitationTotal);
    if (total !== undefined && total > 0 && (rawCitationValid === undefined || valid !== undefined)) {
      citationSamples += 1;
      citationTotal += total;
      citationValid += Math.min(valid ?? 0, total);
    }
    const followup = observation?.followupRequired ?? item.followupRequired?.[variant];
    if (followup !== undefined) {
      followupSamples += 1;
      if (followup) followups += 1;
    }
    const latency = nonNegative(observation?.latencyMs ?? item.latencyMs?.[variant]);
    if (latency !== undefined) latencies.push(latency);
    const leaks = nonNegative(observation?.aclLeaks ?? item.aclLeaks?.[variant]);
    if (leaks !== undefined) {
      aclAuditSamples += 1;
      aclLeaks += leaks;
    }
  }

  const count = cases.length;
  const precision = count === 0 ? 0 : macroPrecision / count;
  const recall = count === 0 ? 0 : macroRecall / count;
  const meanCandidateCount = count === 0 ? 0 : candidateCount / count;
  return {
    variant,
    cases: count,
    precision,
    recall,
    macroPrecision: precision,
    macroRecall: recall,
    mrr: count === 0 ? 0 : reciprocalRank / count,
    hitRate: count === 0 ? 0 : hits / count,
    candidateCount,
    meanCandidateCount,
    citationPrecision: citationTotal === 0 ? 0 : citationValid / citationTotal,
    citationSamples,
    followupRate: followupSamples === 0 ? 0 : followups / followupSamples,
    followupSamples,
    p95LatencyMs: percentile95(latencies),
    latencySamples: latencies.length,
    aclLeaks,
    aclAuditSamples,
  };
}

export function assessRelationWalkIncrement(
  metrics: readonly RelationVariantMetrics[],
  thresholds?: Partial<RelationWalkIncrementThresholds>,
): RelationWalkIncrementAssessment;
export function assessRelationWalkIncrement(
  oneHop: RelationVariantMetrics,
  relationWalk: RelationVariantMetrics,
  thresholds?: Partial<RelationWalkIncrementThresholds>,
): RelationWalkIncrementAssessment;
export function assessRelationWalkIncrement(
  metricsOrOneHop: readonly RelationVariantMetrics[] | RelationVariantMetrics,
  relationWalkOrThresholds?: RelationVariantMetrics | Partial<RelationWalkIncrementThresholds>,
  thresholdOverrides?: Partial<RelationWalkIncrementThresholds>,
): RelationWalkIncrementAssessment {
  const fromArray = Array.isArray(metricsOrOneHop);
  const oneHop = fromArray
    ? metricsOrOneHop.find(metric => metric.variant === 'B')
    : metricsOrOneHop as RelationVariantMetrics;
  const relationWalk = fromArray
    ? metricsOrOneHop.find(metric => metric.variant === 'C')
    : relationWalkOrThresholds as RelationVariantMetrics | undefined;
  const overrides = fromArray
    ? relationWalkOrThresholds as Partial<RelationWalkIncrementThresholds> | undefined
    : thresholdOverrides;
  if (!oneHop || !relationWalk) return { eligible: false, reasons: ['MISSING_VARIANT_METRICS'] };

  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  const reasons: RelationWalkIncrementReason[] = [];
  if (oneHop.cases < 1 || relationWalk.cases < 1 || oneHop.cases !== relationWalk.cases
    || !hasRequiredObservationSamples(oneHop) || !hasRequiredObservationSamples(relationWalk)) {
    reasons.push('INSUFFICIENT_SAMPLES');
  }
  if (!validMetrics(oneHop) || !validMetrics(relationWalk)) reasons.push('INVALID_METRICS');
  if (!validThresholds(thresholds)) reasons.push('INVALID_THRESHOLDS');
  if (reasons.length > 0) return { eligible: false, reasons };

  if (relationWalk.recall - oneHop.recall + METRIC_EPSILON < thresholds.minRecallGain) {
    reasons.push('RECALL_GAIN_BELOW_THRESHOLD');
  }
  if (oneHop.followupRate - relationWalk.followupRate + METRIC_EPSILON < thresholds.minFollowupReduction) {
    reasons.push('FOLLOWUP_REDUCTION_BELOW_THRESHOLD');
  }
  if (oneHop.citationPrecision - relationWalk.citationPrecision
    > thresholds.maxCitationPrecisionDrop + METRIC_EPSILON) {
    reasons.push('CITATION_PRECISION_DROP_ABOVE_THRESHOLD');
  }
  if (oneHop.aclLeaks !== 0 || relationWalk.aclLeaks !== 0) reasons.push('ACL_LEAKS_DETECTED');
  return { eligible: reasons.length === 0, reasons };
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function nonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasRequiredObservationSamples(value: RelationVariantMetrics): boolean {
  return [value.citationSamples, value.followupSamples, value.latencySamples, value.aclAuditSamples]
    .every(samples => Number.isInteger(samples) && samples >= 1);
}

function validMetrics(value: RelationVariantMetrics): boolean {
  const ratios = [value.precision, value.recall, value.macroPrecision, value.macroRecall,
    value.mrr, value.hitRate, value.citationPrecision, value.followupRate];
  const observationSamples = [value.citationSamples, value.followupSamples,
    value.latencySamples, value.aclAuditSamples];
  return Number.isInteger(value.cases) && value.cases > 0
    && ratios.every(metric => Number.isFinite(metric) && metric >= 0 && metric <= 1)
    && [value.candidateCount, value.meanCandidateCount, value.p95LatencyMs, value.aclLeaks]
      .every(metric => Number.isFinite(metric) && metric >= 0)
    && observationSamples.every(samples => Number.isInteger(samples)
      && samples >= 0 && samples <= value.cases);
}

function validThresholds(value: RelationWalkIncrementThresholds): boolean {
  return [value.minRecallGain, value.minFollowupReduction, value.maxCitationPrecisionDrop]
    .every(metric => Number.isFinite(metric) && metric >= 0 && metric <= 1);
}
