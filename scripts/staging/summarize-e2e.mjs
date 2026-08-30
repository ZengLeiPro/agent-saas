#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { resolve } from 'node:path';
import { canonicalJson, digestBuffer } from '../release/artifact-lib.mjs';

const REQUIRED_SCENARIO_FILES = Object.freeze([
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
]);
const REQUIRED_RESPONSIVE_SCENARIO_FILES = Object.freeze([
  'auth.spec.ts',
  'chat-stream.spec.ts',
]);

function flattenSuites(suites, inheritedFile = '') {
  const rows = [];
  for (const suite of suites ?? []) {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        rows.push({
          file,
          title: spec.title,
          projectName: test.projectName,
          status: test.status,
          results: test.results ?? [],
        });
      }
    }
    rows.push(...flattenSuites(suite.suites, file));
  }
  return rows;
}

export function summarizeStagingE2e(report) {
  const executions = flattenSuites(report.suites);
  if (!executions.length) throw new Error('Staging E2E report contains no executions');
  const scenarios = new Set(executions.map((item) => `${item.file}\0${item.title}`));
  const scenarioFiles = [...new Set(executions.map((item) => basename(item.file)))].sort();
  const projects = [...new Set(executions.map((item) => item.projectName).filter(Boolean))].sort();
  const failed = executions.filter(
    (item) => item.status !== 'expected' || item.results.at(-1)?.status !== 'passed',
  );
  if (failed.length)
    throw new Error(`Staging E2E report contains ${failed.length} failed execution(s)`);
  for (const requiredFile of REQUIRED_SCENARIO_FILES) {
    if (!scenarioFiles.includes(requiredFile))
      throw new Error(`Staging E2E report is missing required scenario ${requiredFile}`);
  }
  for (const requiredFile of REQUIRED_SCENARIO_FILES) {
    if (!executions.some((item) => basename(item.file) === requiredFile && item.projectName === 'desktop-chromium'))
      throw new Error(`Staging scenario ${requiredFile} did not pass the desktop project`);
  }
  for (const requiredFile of REQUIRED_RESPONSIVE_SCENARIO_FILES) {
    if (!executions.some((item) => basename(item.file) === requiredFile && item.projectName === 'mobile-chromium'))
      throw new Error(`Responsive Staging scenario ${requiredFile} did not pass the mobile project`);
  }
  const body = {
    schemaVersion: 2,
    scenarioCount: scenarios.size,
    executionCount: executions.length,
    scenarioFiles,
    projects,
    responsiveScenarioFiles: [...REQUIRED_RESPONSIVE_SCENARIO_FILES],
    traceMode: 'off',
    artifactMode: 'json-html-screenshot-video',
    status: 'passed',
  };
  return { ...body, evidenceDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
}

export function validateStagingE2eSummary(summary) {
  const { evidenceDigest, ...body } = summary ?? {};
  if (
    body.schemaVersion !== 2 ||
    body.status !== 'passed' ||
    body.traceMode !== 'off' ||
    body.artifactMode !== 'json-html-screenshot-video' ||
    !Number.isSafeInteger(body.scenarioCount) ||
    body.scenarioCount < 1 ||
    !Number.isSafeInteger(body.executionCount) ||
    body.executionCount < body.scenarioCount ||
    !Array.isArray(body.scenarioFiles) ||
    REQUIRED_SCENARIO_FILES.some((file) => !body.scenarioFiles.includes(file)) ||
    !Array.isArray(body.responsiveScenarioFiles) ||
    REQUIRED_RESPONSIVE_SCENARIO_FILES.some((file) => !body.responsiveScenarioFiles.includes(file)) ||
    !Array.isArray(body.projects) ||
    !body.projects.includes('desktop-chromium') ||
    !body.projects.includes('mobile-chromium') ||
    evidenceDigest !== digestBuffer(Buffer.from(canonicalJson(body)))
  ) {
    throw new Error('Staging E2E summary is incomplete, failed, or has an invalid digest');
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (input === 'verify' && output) {
    const summary = validateStagingE2eSummary(JSON.parse(await readFile(resolve(output), 'utf8')));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  }
  if (!input || !output)
    throw new Error('usage: summarize-e2e.mjs <playwright.json> <summary.json>');
  const summary = summarizeStagingE2e(JSON.parse(await readFile(resolve(input), 'utf8')));
  await writeFile(resolve(output), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
