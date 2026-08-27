import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeStagingE2e, validateStagingE2eSummary } from './summarize-e2e.mjs';

test('reports business scenarios separately from viewport executions', () => {
  const files = [
    'acs-isolation.spec.ts',
    'acs-orchestrator-restart.spec.ts',
    'acs-pause-resume.spec.ts',
    'agent-acs-tools.spec.ts',
    'artifact.spec.ts',
    'auth.spec.ts',
    'background-resume.spec.ts',
    'cancellation.spec.ts',
    'chat-stream.spec.ts',
    'network-reconnect.spec.ts',
    'runtime-worker-restart.spec.ts',
    'taskboard-integration.spec.ts',
    'timeout-recovery.spec.ts',
    'tool-approval.spec.ts',
  ];
  const report = {
    suites: files.map((file) => ({
      file,
      specs: [
        {
          title: 'agent tools',
          tests: [
            {
              projectName: 'desktop-chromium',
              status: 'expected',
              results: [{ status: 'passed' }],
            },
            {
              projectName: 'mobile-chromium',
              status: 'expected',
              results: [{ status: 'passed' }],
            },
          ],
        },
      ],
    })),
  };
  const summary = summarizeStagingE2e(report);
  assert.equal(summary.scenarioCount, 14);
  assert.equal(summary.executionCount, 28);
  assert.equal(validateStagingE2eSummary(summary), summary);
});
