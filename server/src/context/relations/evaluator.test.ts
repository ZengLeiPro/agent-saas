import { describe, expect, it } from 'vitest';

import {
  assessRelationWalkIncrement,
  evaluateRelationVariants,
  type RelationVariantMetrics,
} from './evaluator.js';

describe('evaluateRelationVariants', () => {
  it('computes deterministic macro ranking, quality, latency and safety metrics', () => {
    const input = [{
      caseId: 'case-1', relevantEntityIds: ['p1', 'p2'],
      candidates: { A: ['p1'], B: ['p1', 'noise'], C: ['p1', 'p2', 'p2'] },
      citationValid: { A: 1, B: 1, C: 2 }, citationTotal: { A: 1, B: 2, C: 2 },
      followupRequired: { A: false, B: true, C: false },
      latencyMs: { A: 10, B: 40, C: 30 }, aclLeaks: { A: 0, B: 0, C: 0 },
    }, {
      caseId: 'case-2', relevantEntityIds: ['p3'],
      candidates: { A: [], B: ['p3'], C: ['noise'] },
      citationValid: { B: 1, C: 0 }, citationTotal: { B: 1, C: 1 },
      followupRequired: { B: false, C: true }, latencyMs: { B: 20, C: 50 }, aclLeaks: { C: 1 },
    }];

    const first = evaluateRelationVariants(input);
    expect(evaluateRelationVariants(input)).toEqual(first);
    expect(first).toEqual([
      metric('A', { precision: 0.5, recall: 0.25, mrr: 0.5, hitRate: 0.5, candidateCount: 1,
        citationPrecision: 1, followupRate: 0, p95LatencyMs: 10, aclLeaks: 0 }, 2,
      { citationSamples: 1, followupSamples: 1, latencySamples: 1, aclAuditSamples: 1 }),
      metric('B', { precision: 0.75, recall: 0.75, mrr: 1, hitRate: 1, candidateCount: 3,
        citationPrecision: 2 / 3, followupRate: 0.5, p95LatencyMs: 40, aclLeaks: 0 }, 2,
      { citationSamples: 2, followupSamples: 2, latencySamples: 2, aclAuditSamples: 1 }),
      metric('C', { precision: 0.5, recall: 0.5, mrr: 0.5, hitRate: 0.5, candidateCount: 3,
        citationPrecision: 2 / 3, followupRate: 0.5, p95LatencyMs: 50, aclLeaks: 1 }, 2,
      { citationSamples: 2, followupSamples: 2, latencySamples: 2, aclAuditSamples: 2 }),
    ]);
  });

  it('returns explicit zero sample counts for an empty offline set', () => {
    expect(evaluateRelationVariants([])).toEqual(['A', 'B', 'C'].map(variant => metric(
      variant as 'A' | 'B' | 'C',
      { precision: 0, recall: 0, mrr: 0, hitRate: 0, candidateCount: 0,
        citationPrecision: 0, followupRate: 0, p95LatencyMs: 0, aclLeaks: 0 },
      0,
    )));
  });

  it('keeps nonempty ranking cases distinct from absent observation samples', () => {
    const metrics = evaluateRelationVariants([{
      caseId: 'ranking-only', relevantEntityIds: ['p1'],
      candidates: { A: [], B: ['p1', 'noise'], C: ['p1'] },
    }]);

    expect(metrics.map(({ cases, candidateCount, meanCandidateCount, citationSamples,
      followupSamples, latencySamples, aclAuditSamples }) => ({
      cases, candidateCount, meanCandidateCount, citationSamples,
      followupSamples, latencySamples, aclAuditSamples,
    }))).toEqual([
      { cases: 1, candidateCount: 0, meanCandidateCount: 0, citationSamples: 0,
        followupSamples: 0, latencySamples: 0, aclAuditSamples: 0 },
      { cases: 1, candidateCount: 2, meanCandidateCount: 2, citationSamples: 0,
        followupSamples: 0, latencySamples: 0, aclAuditSamples: 0 },
      { cases: 1, candidateCount: 1, meanCandidateCount: 1, citationSamples: 0,
        followupSamples: 0, latencySamples: 0, aclAuditSamples: 0 },
    ]);
    expect(assessRelationWalkIncrement(metrics)).toEqual({
      eligible: false, reasons: ['INSUFFICIENT_SAMPLES'],
    });
  });

  it('does not count zero-denominator citation observations as samples', () => {
    const metrics = evaluateRelationVariants([{
      caseId: 'zero-citations', relevantEntityIds: ['p1'],
      candidates: { A: [], B: ['p1'], C: ['p1'] },
      observations: {
        B: { citationValid: 0, citationTotal: 0, followupRequired: false, latencyMs: 1, aclLeaks: 0 },
        C: { citationValid: 0, citationTotal: 0, followupRequired: false, latencyMs: 1, aclLeaks: 0 },
      },
    }]);
    expect(metrics.filter(metric => metric.variant !== 'A').map(metric => metric.citationSamples)).toEqual([0, 0]);
    expect(assessRelationWalkIncrement(metrics)).toEqual({
      eligible: false, reasons: ['INSUFFICIENT_SAMPLES'],
    });
  });

  it('does not count negative or NaN numeric observations as samples', () => {
    const metrics = evaluateRelationVariants([{
      caseId: 'partially-observed', relevantEntityIds: ['p1'],
      candidates: { A: [], B: ['p1'], C: ['p1'] },
      observations: {
        B: { citationValid: 1, citationTotal: 1, followupRequired: true, latencyMs: 10, aclLeaks: 0 },
        C: { citationValid: Number.NaN, citationTotal: 1, followupRequired: false,
          latencyMs: -1, aclLeaks: Number.NaN },
      },
    }]);
    const oneHop = metrics.find(metric => metric.variant === 'B');
    const walk = metrics.find(metric => metric.variant === 'C');

    expect(oneHop).toMatchObject({
      citationSamples: 1, followupSamples: 1, latencySamples: 1, aclAuditSamples: 1,
    });
    expect(walk).toMatchObject({
      citationSamples: 0, followupSamples: 1, latencySamples: 0, aclAuditSamples: 0,
    });
    expect(assessRelationWalkIncrement(metrics)).toEqual({
      eligible: false, reasons: ['INSUFFICIENT_SAMPLES'],
    });
  });
});

describe('assessRelationWalkIncrement', () => {
  it('marks a bounded walk eligible only when all default increments pass', () => {
    const oneHop = metric('B', { precision: 0.8, recall: 0.6, mrr: 0.7, hitRate: 0.8, candidateCount: 3,
      citationPrecision: 0.9, followupRate: 0.2, p95LatencyMs: 20, aclLeaks: 0 });
    const walk = metric('C', { precision: 0.8, recall: 0.66, mrr: 0.7, hitRate: 0.8, candidateCount: 5,
      citationPrecision: 0.895, followupRate: 0.09, p95LatencyMs: 30, aclLeaks: 0 });

    expect(assessRelationWalkIncrement(oneHop, walk)).toEqual({ eligible: true, reasons: [] });
    expect(assessRelationWalkIncrement([oneHop, walk])).toEqual({ eligible: true, reasons: [] });
  });

  it('returns all failed gate reasons without making a deployment claim', () => {
    const oneHop = metric('B', { precision: 0.8, recall: 0.6, mrr: 0.7, hitRate: 0.8, candidateCount: 3,
      citationPrecision: 0.9, followupRate: 0.2, p95LatencyMs: 20, aclLeaks: 0 });
    const walk = metric('C', { precision: 0.8, recall: 0.64, mrr: 0.7, hitRate: 0.8, candidateCount: 5,
      citationPrecision: 0.88, followupRate: 0.11, p95LatencyMs: 30, aclLeaks: 1 });

    expect(assessRelationWalkIncrement(oneHop, walk)).toEqual({
      eligible: false,
      reasons: [
        'RECALL_GAIN_BELOW_THRESHOLD',
        'FOLLOWUP_REDUCTION_BELOW_THRESHOLD',
        'CITATION_PRECISION_DROP_ABOVE_THRESHOLD',
        'ACL_LEAKS_DETECTED',
      ],
    });
  });

  it('rejects empty, mismatched or invalid evidence instead of declaring an increment', () => {
    const empty = metric('B', { precision: 0, recall: 0, mrr: 0, hitRate: 0, candidateCount: 0,
      citationPrecision: 0, followupRate: 0, p95LatencyMs: 0, aclLeaks: 0 }, 0);
    const walk = metric('C', { precision: 0.8, recall: 0.8, mrr: 0.8, hitRate: 0.8, candidateCount: 4,
      citationPrecision: 1, followupRate: 0, p95LatencyMs: 10, aclLeaks: 0 }, 2);
    expect(assessRelationWalkIncrement(empty, walk)).toEqual({
      eligible: false, reasons: ['INSUFFICIENT_SAMPLES', 'INVALID_METRICS'],
    });

    const invalid = { ...walk, recall: Number.NaN };
    expect(assessRelationWalkIncrement(metric('B', { precision: 0.8, recall: 0.6, mrr: 0.8,
      hitRate: 0.8, candidateCount: 2, citationPrecision: 1, followupRate: 0.2,
      p95LatencyMs: 8, aclLeaks: 0 }), invalid)).toEqual({
      eligible: false, reasons: ['INVALID_METRICS'],
    });
    expect(assessRelationWalkIncrement(
      metric('B', { precision: 0.8, recall: 0.6, mrr: 0.8, hitRate: 0.8, candidateCount: 2,
        citationPrecision: 1, followupRate: 0.2, p95LatencyMs: 8, aclLeaks: 0 }),
      walk,
      { minRecallGain: Number.NaN },
    )).toEqual({ eligible: false, reasons: ['INVALID_THRESHOLDS'] });
  });
});

type ObservationSampleCounts = Pick<RelationVariantMetrics,
  'citationSamples' | 'followupSamples' | 'latencySamples' | 'aclAuditSamples'>;

function metric(
  variant: 'A' | 'B' | 'C',
  values: Pick<RelationVariantMetrics, 'precision' | 'recall' | 'mrr' | 'hitRate' | 'candidateCount'
    | 'citationPrecision' | 'followupRate' | 'p95LatencyMs' | 'aclLeaks'>,
  cases = 2,
  samples: Partial<ObservationSampleCounts> = {},
): RelationVariantMetrics {
  const defaultSamples = cases > 0 ? 1 : 0;
  return {
    variant, cases,
    precision: values.precision, recall: values.recall,
    macroPrecision: values.precision, macroRecall: values.recall,
    mrr: values.mrr, hitRate: values.hitRate,
    candidateCount: values.candidateCount,
    meanCandidateCount: cases === 0 ? 0 : values.candidateCount / cases,
    citationPrecision: values.citationPrecision,
    citationSamples: samples.citationSamples ?? defaultSamples,
    followupRate: values.followupRate,
    followupSamples: samples.followupSamples ?? defaultSamples,
    p95LatencyMs: values.p95LatencyMs,
    latencySamples: samples.latencySamples ?? defaultSamples,
    aclLeaks: values.aclLeaks,
    aclAuditSamples: samples.aclAuditSamples ?? defaultSamples,
  };
}
