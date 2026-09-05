import { describe, expect, it } from 'vitest'; // pure lifecycle policy coverage
import { isSessionAutomationLifecycleReceiptForJob, lifecycleRetryDelaySeconds, lifecycleWaitsForAuthority, type SessionAutomationLifecycleJob, type SessionAutomationLifecycleReceipt } from './sessionAutomationStore.js';

describe('typed automation lifecycle receipts', () => {
  const job: SessionAutomationLifecycleJob = {
    workId: '00000000-0000-0000-0000-000000000001', tenantId: 'tenant', sessionId: 'session',
    automationId: '00000000-0000-0000-0000-000000000002', incarnationId: '00000000-0000-0000-0000-000000000003',
    generation: 7, objectIncarnationId: '00000000-0000-0000-0000-000000000003', objectGeneration: 6,
    objectType: 'provider_attempt', objectId: '00000000-0000-0000-0000-000000000004', action: 'reconcile',
    attemptCount: 1, details: {},
  };
  const receipt: SessionAutomationLifecycleReceipt = {
    workId: job.workId, tenantId: job.tenantId, sessionId: job.sessionId, automationId: job.automationId,
    incarnationId: job.incarnationId, generation: job.generation, objectIncarnationId: job.objectIncarnationId,
    objectGeneration: job.objectGeneration, objectType: job.objectType, objectId: job.objectId, action: job.action,
    receiptKey: 'provider:receipt-1', authority: 'provider', outcome: 'completed', payload: { providerState: 'completed' },
  };
  it('uses bounded exponential retry and parks external authority objects', () => {
    expect([1,2,3,7,100].map(lifecycleRetryDelaySeconds)).toEqual([5,10,20,300,300]);
    expect(lifecycleWaitsForAuthority('provider_attempt')).toBe(true);
    expect(lifecycleWaitsForAuthority('interaction')).toBe(true);
    expect(lifecycleWaitsForAuthority('background_resource')).toBe(true);
    expect(lifecycleWaitsForAuthority('evaluation')).toBe(false);
  });

  it('requires the complete automation and object fence', () => {
    expect(isSessionAutomationLifecycleReceiptForJob(job, receipt)).toBe(true);
    expect(isSessionAutomationLifecycleReceiptForJob(job, { ...receipt, generation: 8 })).toBe(false);
    expect(isSessionAutomationLifecycleReceiptForJob(job, { ...receipt, objectGeneration: 7 })).toBe(false);
    expect(isSessionAutomationLifecycleReceiptForJob(job, { ...receipt, objectId: 'other' })).toBe(false);
  });
});
