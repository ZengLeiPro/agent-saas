import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { readEvidenceFile, readEvidenceJson } from './evidence-file.mjs';

export const ASSET_DIAGNOSTIC_LIMITS = Object.freeze({
  directoryEntries: 4096, files: 1024, fileBytes: 512000, totalBytes: 4194304, events: 2000,
});
const phases = new Set([
  'compress', 'put', 'readback', 'metadata', 'public-head', 'public-headers',
  'verify', 'get', 'byte-compare', 'preflight',
]);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
export function safeAssetEvent(value) {
  if (!value || !/^[A-Za-z0-9._/-]{1,512}$/u.test(value.key ?? '') || !phases.has(value.phase) ||
    ![value.attempt, value.exitCode, value.durationSeconds].every(count)) return null;
  return {
    key: value.key, phase: value.phase, attempt: value.attempt,
    exitCode: value.exitCode, durationSeconds: value.durationSeconds,
  };
}
function safeBatch(value) {
  const fields = ['total', 'completed', 'uploaded', 'reused', 'concurrency',
    'requestTimeoutSeconds', 'elapsedSeconds', 'exitCode'];
  if (value?.schemaVersion !== 1 || !fields.every((key) => count(value[key])) ||
    !['running', 'completed', 'failed'].includes(value.status) || value.total < 1 ||
    value.completed > value.total || value.uploaded + value.reused !== value.completed ||
    value.concurrency < 1 || value.concurrency > 8 ||
    value.requestTimeoutSeconds < 1 || value.requestTimeoutSeconds > 120 ||
    (value.status === 'completed' && (value.exitCode !== 0 || value.completed !== value.total)) ||
    (value.status === 'failed' && value.exitCode === 0)) return null;
  return { schemaVersion: 1, status: value.status,
    ...Object.fromEntries(fields.map((key) => [key, value[key]])) };
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { samples: sorted.length, p50Seconds: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Seconds: sorted[Math.ceil(sorted.length * 0.95) - 1], maxSeconds: sorted.at(-1) };
}

/** Read every per-ASSET worker file within explicit file/byte/event budgets, not 8 slots.
 * Nonzero events displace successful events when the output budget fills. No raw log leaves here.
 */
export async function collectAssetDiagnostics(directory) {
  const limits = ASSET_DIAGNOSTIC_LIMITS;
  const reasons = new Set();
  const names = [];
  let discoveryComplete = true;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid directory');
    let entries = 0;
    for await (const entry of await opendir(directory)) {
      if (++entries > limits.directoryEntries) {
        reasons.add('directory_entry_limit'); discoveryComplete = false; break;
      }
      if (/^worker-[0-9]+\.jsonl$/u.test(entry.name)) names.push(entry.name);
    }
  } catch {
    reasons.add('diagnostics_unavailable'); discoveryComplete = false;
  }
  names.sort();
  if (names.length > limits.files) reasons.add('file_count_limit');
  const retained = [];
  const assets = new Map();
  const timings = new Map();
  let bytesRead = 0, filesRead = 0, validEvents = 0, invalidLines = 0, nonzeroEvents = 0;
  for (const name of names.slice(0, limits.files)) {
    const remaining = limits.totalBytes - bytesRead;
    if (!remaining) { reasons.add('total_byte_limit'); break; }
    let bytes;
    try {
      bytes = await readEvidenceFile(join(directory, name), Math.min(limits.fileBytes, remaining));
    } catch {
      reasons.add(remaining < limits.fileBytes ? 'total_byte_limit' : 'file_unreadable_or_oversized');
      continue;
    }
    bytesRead += bytes.length; filesRead++;
    let lines;
    try {
      lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter((line) => line.trim());
    } catch { reasons.add('invalid_utf8'); continue; }
    if (!lines.length) reasons.add('empty_worker_file');
    for (const line of lines) {
      let event;
      try { event = safeAssetEvent(JSON.parse(line)); } catch { /* Count below; never export text. */ }
      if (!event) { invalidLines++; reasons.add('invalid_event'); continue; }
      const sequence = validEvents++;
      if (event.exitCode !== 0) nonzeroEvents++;
      const asset = assets.get(event.key) ?? { mask: 0, terminalCount: 0, terminalCode: null };
      if (event.phase === 'put' && [0, 17].includes(event.exitCode)) asset.mask |= 1;
      if (event.phase === 'readback' && event.exitCode === 0) asset.mask |= 2;
      if (event.phase === 'public-head' && event.exitCode === 0) asset.mask |= 4;
      if (event.phase === 'verify') {
        asset.terminalCount++; asset.terminalCode = event.exitCode;
        if (event.exitCode === 0) asset.mask |= 8;
        if (asset.terminalCount > 1) reasons.add('duplicate_terminal_event');
      }
      assets.set(event.key, asset);
      const samples = timings.get(event.phase) ?? [];
      samples.push(event.durationSeconds); timings.set(event.phase, samples);
      if (retained.length < limits.events) retained.push({ event, sequence });
      else {
        reasons.add('event_limit');
        if (event.exitCode !== 0) {
          const slot = retained.findLastIndex((item) => item.event.exitCode === 0);
          if (slot >= 0) retained[slot] = { event, sequence };
        }
      }
    }
  }

  let batch = null;
  if (discoveryComplete) {
    try {
      batch = safeBatch(await readEvidenceJson(join(directory, 'batch.json')));
      if (!batch) reasons.add('batch_receipt_invalid');
    } catch (error) {
      reasons.add(error.code === 'ENOENT' ? 'batch_receipt_missing' : 'batch_receipt_unreadable');
    }
  }
  const values = [...assets.values()];
  const terminalSuccesses = values.filter((value) => value.terminalCode === 0).length;
  const terminalFailures = values.filter((value) => value.terminalCode !== null && value.terminalCode !== 0).length;
  if (batch && (batch.status !== 'completed' || batch.total !== assets.size ||
    terminalSuccesses !== batch.total || values.some((value) => value.mask !== 15)))
    reasons.add('batch_trace_incomplete');
  const truncated = [...reasons].some((reason) => reason !== 'batch_receipt_missing');
  const complete = reasons.size === 0 && batch?.status === 'completed';
  const events = retained.sort((a, b) => a.sequence - b.sequence).map((item) => item.event);
  return {
    events, truncated,
    coverage: {
      status: complete ? 'complete' : truncated || batch ? 'partial' : 'unverified',
      discoveryComplete, filesDiscovered: names.length, filesRead,
      filesOmitted: names.length - filesRead, bytesRead, validEvents,
      eventsOmitted: validEvents - events.length, invalidLines, assetsObserved: assets.size,
      terminalSuccesses, terminalFailures, nonzeroEvents,
      nonzeroEventsOmitted: nonzeroEvents - events.filter((event) => event.exitCode !== 0).length,
      reasons: [...reasons].sort(), limits,
    },
    batch,
    // A complete observed batch, not the retained sample, is the only percentile population.
    phaseTimings: complete ? Object.fromEntries([...timings].map(([phase, samples]) =>
      [phase, distribution(samples)])) : null,
    resourceTimings: complete ? distribution(timings.get('verify') ?? []) : null,
  };
}
