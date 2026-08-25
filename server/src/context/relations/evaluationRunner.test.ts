import { describe, expect, it } from 'vitest';

import { runRelationEvaluation } from './evaluationRunner.js';

const hash = 'a'.repeat(64);
const passingDataset = {
  version: 1,
  maxCandidatesPerVariant: 10,
  thresholds: { minRecallGain: 0.2, minFollowupReduction: 0.5, maxCitationPrecisionDrop: 0 },
  cases: [{
    caseId: 'project-owner',
    relevantEntityIds: ['person-a', 'person-b'],
    candidates: { A: ['person-a'], B: ['person-a'], C: ['person-a', 'person-b'] },
    observations: {
      A: { citationValid: 1, citationTotal: 1, followupRequired: true, latencyMs: 10, aclLeaks: 0 },
      B: { citationValid: 1, citationTotal: 1, followupRequired: true, latencyMs: 12, aclLeaks: 0 },
      C: { citationValid: 2, citationTotal: 2, followupRequired: false, latencyMs: 15, aclLeaks: 0 },
    },
  }],
};

describe('relation evaluation runner', () => {
  it('produces a deterministic A/B/C report and passes only an eligible bounded two-hop increment', () => {
    const report = runRelationEvaluation(passingDataset, hash);
    expect(report).toMatchObject({
      version: 1, datasetSha256: hash, caseCount: 1, maxCandidatesPerVariant: 10,
      relationWalkAssessment: { eligible: true, reasons: [] }, passed: true,
    });
    expect(report.metrics.map(metric => [metric.variant, metric.recall])).toEqual([
      ['A', 0.5], ['B', 0.5], ['C', 1],
    ]);
  });

  it('fails closed for ACL leaks, duplicate cases and over-cap candidate lists', () => {
    const leaked = structuredClone(passingDataset);
    leaked.cases[0]!.observations.B!.aclLeaks = 1;
    expect(runRelationEvaluation(leaked, hash)).toMatchObject({
      passed: false,
      relationWalkAssessment: { eligible: false, reasons: ['ACL_LEAKS_DETECTED'] },
    });
    expect(() => runRelationEvaluation({
      ...passingDataset, cases: [passingDataset.cases[0], passingDataset.cases[0]],
    }, hash)).toThrow('duplicate caseId');
    expect(() => runRelationEvaluation({
      ...passingDataset, maxCandidatesPerVariant: 1,
      cases: [{ ...passingDataset.cases[0], candidates: { A: [], B: [], C: ['a', 'b'] } }],
    }, hash)).toThrow('exceeds maxCandidatesPerVariant');
    const invalidCitation = structuredClone(passingDataset);
    invalidCitation.cases[0]!.observations.C!.citationValid = 3;
    invalidCitation.cases[0]!.observations.C!.citationTotal = 2;
    expect(() => runRelationEvaluation(invalidCitation, hash)).toThrow('citationValid exceeds citationTotal');
  });
});
