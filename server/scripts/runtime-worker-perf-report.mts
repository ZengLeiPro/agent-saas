import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface MeasurementWindow {
  wave: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface LoadTier {
  concurrency: number;
  waves: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  measurementWindows: MeasurementWindow[];
  success: number;
  failed: number;
  errorRate: number;
  latencyMs: {
    firstProgressP95?: number;
    doneP50: number;
    doneP95: number;
    doneMax: number;
  };
}

interface LoadReport {
  schemaVersion: number;
  benchmarkStartedAt: string;
  benchmarkCompletedAt: string;
  plan: Record<string, unknown>;
  tiers: LoadTier[];
  abortedReason?: string;
}

interface PerfSample extends Record<string, unknown> {
  sampledAt: string;
  intervalMs: number;
  process: Record<string, unknown>;
  host?: Record<string, unknown>;
  cgroup?: Record<string, unknown>;
  workload?: Record<string, unknown>;
}

interface MetricSummary {
  min?: number;
  p50?: number;
  p95?: number;
  max?: number;
  avg?: number;
  first?: number;
  last?: number;
  delta?: number;
}

interface TierPerfSummary {
  concurrency: number;
  waves: number;
  measuredRuns: number;
  success: number;
  failed: number;
  errorRate: number;
  doneP95Ms: number;
  sampleCount: number;
  baselineSampleCount: number;
  recoverySampleCount: number;
  metrics: Record<string, MetricSummary>;
  peakAboveBaseline: Record<string, number>;
  memoryEventDelta: Record<string, number>;
  cpuThrottleDelta: Record<string, number>;
  ioDelta: Record<string, number>;
  admissionPausedSamples: number;
  warnings: string[];
}

const METRICS: Record<string, string> = {
  processCpuPercent: 'process.cpuPercent',
  cgroupCpuPercent: 'cgroup.cpuPercent',
  eventLoopUtilization: 'process.eventLoopUtilization',
  eventLoopDelayP95Ms: 'process.eventLoopDelayP95Ms',
  eventLoopDelayP99Ms: 'process.eventLoopDelayP99Ms',
  eventLoopDelayMaxMs: 'process.eventLoopDelayMaxMs',
  gcDurationMs: 'process.gc.durationMs',
  gcMaxDurationMs: 'process.gc.maxDurationMs',
  rssBytes: 'process.rssBytes',
  heapUsedBytes: 'process.heapUsedBytes',
  externalBytes: 'process.externalBytes',
  arrayBuffersBytes: 'process.arrayBuffersBytes',
  cgroupMemoryCurrentBytes: 'cgroup.memoryCurrentBytes',
  cgroupAnonBytes: 'cgroup.memory.anon',
  cgroupFileBytes: 'cgroup.memory.file',
  cgroupInactiveFileBytes: 'cgroup.memory.inactive_file',
  cgroupSlabReclaimableBytes: 'cgroup.memory.slab_reclaimable',
  cgroupSlabUnreclaimableBytes: 'cgroup.memory.slab_unreclaimable',
  hostAvailableBytes: 'host.availableBytes',
  memoryPsiSomeAvg10: 'host.memoryPsi.someAvg10',
  memoryPsiFullAvg10: 'host.memoryPsi.fullAvg10',
  localInFlightRuns: 'workload.scheduler.inFlightRuns',
  globalPendingRuns: 'workload.activeRuns.pending',
  globalRunningRuns: 'workload.activeRuns.running',
  globalBlockingRuns: 'workload.activeRuns.blocking',
  oldestInFlightAgeMs: 'workload.scheduler.oldestInFlightAgeMs',
};

const PEAK_BASELINE_METRICS = [
  'rssBytes',
  'heapUsedBytes',
  'externalBytes',
  'arrayBuffersBytes',
  'cgroupMemoryCurrentBytes',
  'cgroupAnonBytes',
  'cgroupFileBytes',
  'cgroupSlabReclaimableBytes',
  'cgroupSlabUnreclaimableBytes',
];

async function main(): Promise<void> {
  const samplesPath = requiredArg('--samples');
  const loadPath = requiredArg('--load');
  const outputMarkdown = resolve(argValue('--output-md') ?? defaultSibling(loadPath, 'Worker容量压测报告.md'));
  const outputJson = resolve(argValue('--output-json') ?? defaultSibling(loadPath, 'Worker容量压测汇总.json'));
  const [samplesRaw, loadRaw] = await Promise.all([
    readFile(resolve(samplesPath), 'utf8'),
    readFile(resolve(loadPath), 'utf8'),
  ]);
  const samples = parsePerfSamples(samplesRaw);
  const load = JSON.parse(loadRaw) as LoadReport;
  if (samples.length === 0) throw new Error(`没有从${samplesPath}解析到[RuntimePerf]样本`);
  if (load.tiers.length === 0) throw new Error(`压测结果${loadPath}不包含tier`);

  const tierSummaries = load.tiers.map((tier) => summarizeTier(tier, samples));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      samples: resolve(samplesPath),
      load: resolve(loadPath),
      sampleCount: samples.length,
      firstSampleAt: samples[0]!.sampledAt,
      lastSampleAt: samples.at(-1)!.sampledAt,
    },
    load: {
      benchmarkStartedAt: load.benchmarkStartedAt,
      benchmarkCompletedAt: load.benchmarkCompletedAt,
      plan: load.plan,
      ...(load.abortedReason ? { abortedReason: load.abortedReason } : {}),
    },
    tiers: tierSummaries,
    findings: buildFindings(load, tierSummaries),
  };
  await mkdir(dirname(outputJson), { recursive: true });
  await mkdir(dirname(outputMarkdown), { recursive: true });
  await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(outputMarkdown, renderMarkdown(report), 'utf8');
  console.log(`[report:json] ${outputJson}`);
  console.log(`[report:markdown] ${outputMarkdown}`);
}

function parsePerfSamples(raw: string): PerfSample[] {
  const samples: PerfSample[] = [];
  for (const line of raw.split('\n')) {
    const marker = line.indexOf('[RuntimePerf]');
    if (marker < 0) continue;
    const jsonStart = line.indexOf('{', marker);
    if (jsonStart < 0) continue;
    try {
      const sample = JSON.parse(line.slice(jsonStart)) as PerfSample;
      if (sample.sampledAt && sample.process) samples.push(sample);
    } catch {
      // journald中不完整的尾行忽略；总样本数会在报告中暴露。
    }
  }
  return samples.sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
}

function summarizeTier(tier: LoadTier, samples: PerfSample[]): TierPerfSummary {
  const windows = tier.measurementWindows?.length
    ? tier.measurementWindows
    : [{ wave: 1, startedAt: tier.startedAt, completedAt: tier.completedAt, durationMs: tier.durationMs }];
  const activeSamples = uniqueSamples(samples.filter((sample) => windows.some((window) => intervalOverlaps(sample, window))));
  const firstStart = Math.min(...windows.map((window) => Date.parse(window.startedAt)));
  const lastEnd = Math.max(...windows.map((window) => Date.parse(window.completedAt)));
  const baselineSamples = samples.filter((sample) => {
    const at = Date.parse(sample.sampledAt);
    return at < firstStart && at >= firstStart - 60_000;
  });
  const recoverySamples = samples.filter((sample) => {
    const at = Date.parse(sample.sampledAt);
    return at > lastEnd && at <= lastEnd + 60_000;
  });
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, path]) => [
    name,
    summarizeNumbers(activeSamples.flatMap((sample) => {
      const value = getNumber(sample, path);
      return value === undefined ? [] : [value];
    })),
  ]));
  const peakAboveBaseline = Object.fromEntries(PEAK_BASELINE_METRICS.flatMap((name) => {
    const path = METRICS[name];
    const delta = path ? peakAboveWindowBaselines(samples, windows, path) : undefined;
    return delta === undefined ? [] : [[name, delta]];
  }));
  const memoryEventDelta = counterDeltasByWindows(samples, windows, 'cgroup.memoryEvents', [
    'low', 'high', 'max', 'oom', 'oom_kill', 'oom_group_kill',
  ]);
  const cpuThrottleDelta = counterDeltasByWindows(samples, windows, 'cgroup.cpu', [
    'nr_periods', 'nr_throttled', 'throttled_usec',
  ]);
  const ioDelta = counterDeltasByWindows(samples, windows, 'cgroup.io', [
    'readBytes', 'writeBytes', 'readOperations', 'writeOperations',
  ]);
  const admissionPausedSamples = activeSamples.filter((sample) => (
    getValue(sample, 'workload.admission.admitting') === false
  )).length;
  const warnings: string[] = [];
  if (activeSamples.length < windows.length) {
    warnings.push(`仅${activeSamples.length}个性能样本覆盖${windows.length}个测量窗口，采样密度不足`);
  }
  if (tier.success + tier.failed < 20) {
    warnings.push(`仅${tier.success + tier.failed}个测量Run，P95仅作描述性参考`);
  }
  if (tier.failed > 0) warnings.push(`${tier.failed}个Run失败`);
  if ((memoryEventDelta.oom ?? 0) > 0 || (memoryEventDelta.oom_kill ?? 0) > 0) {
    warnings.push(`Worker cgroup发生OOM事件：oom=${memoryEventDelta.oom ?? 0} oom_kill=${memoryEventDelta.oom_kill ?? 0}`);
  }
  if (admissionPausedSamples > 0) warnings.push(`内存准入在${admissionPausedSamples}个活动样本中暂停领取新Run`);
  if ((metrics.eventLoopDelayMaxMs?.max ?? 0) >= 500) {
    warnings.push(`Event Loop最大延迟达到${formatNumber(metrics.eventLoopDelayMaxMs.max)}ms`);
  }
  return {
    concurrency: tier.concurrency,
    waves: windows.length,
    measuredRuns: tier.success + tier.failed,
    success: tier.success,
    failed: tier.failed,
    errorRate: tier.errorRate,
    doneP95Ms: tier.latencyMs.doneP95,
    sampleCount: activeSamples.length,
    baselineSampleCount: baselineSamples.length,
    recoverySampleCount: recoverySamples.length,
    metrics,
    peakAboveBaseline,
    memoryEventDelta,
    cpuThrottleDelta,
    ioDelta,
    admissionPausedSamples,
    warnings,
  };
}

function buildFindings(load: LoadReport, tiers: TierPerfSummary[]): string[] {
  const findings: string[] = [];
  if (load.abortedReason) findings.push(`压测提前停止：${load.abortedReason}`);
  const failedTier = tiers.find((tier) => tier.failed > 0);
  if (failedTier) findings.push(`首次出现Run失败：并发${failedTier.concurrency}，失败${failedTier.failed}/${failedTier.measuredRuns}`);
  const pressureTier = tiers.find((tier) => tier.admissionPausedSamples > 0 || (tier.memoryEventDelta.high ?? 0) > 0);
  if (pressureTier) findings.push(`首次出现内存压力信号：并发${pressureTier.concurrency}`);
  const oomTier = tiers.find((tier) => (tier.memoryEventDelta.oom ?? 0) > 0 || (tier.memoryEventDelta.oom_kill ?? 0) > 0);
  if (oomTier) findings.push(`发生Worker cgroup OOM：并发${oomTier.concurrency}`);
  const lagTier = tiers.find((tier) => (tier.metrics.eventLoopDelayMaxMs?.max ?? 0) >= 500);
  if (lagTier) findings.push(`Event Loop首次超过500ms：并发${lagTier.concurrency}`);
  const last = tiers.at(-1);
  if (last && !load.abortedReason && last.failed === 0 && last.admissionPausedSamples === 0 && !oomTier) {
    findings.push(`本轮最高并发${last.concurrency}未触发Run失败、准入暂停或OOM；这只是本场景观测结果，不等于正式安全容量`);
  }
  if (tiers.some((tier) => tier.sampleCount < tier.waves)) {
    findings.push('部分测量窗口缺少性能样本，不能据此排除短时CPU/内存尖峰');
  }
  if (findings.length === 0) findings.push('没有足够证据形成自动结论，请检查各tier样本密度和原始指标');
  return findings;
}

function renderMarkdown(report: {
  generatedAt: string;
  source: { samples: string; load: string; sampleCount: number; firstSampleAt: string; lastSampleAt: string };
  load: { benchmarkStartedAt: string; benchmarkCompletedAt: string; plan: Record<string, unknown>; abortedReason?: string };
  tiers: TierPerfSummary[];
  findings: string[];
}): string {
  const lines = [
    '# Runtime Worker容量压测报告',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 压测区间：${report.load.benchmarkStartedAt} ～ ${report.load.benchmarkCompletedAt}`,
    `- 性能样本：${report.source.sampleCount}（${report.source.firstSampleAt} ～ ${report.source.lastSampleAt}）`,
    `- 负载结果：\`${report.source.load}\``,
    `- 性能日志：\`${report.source.samples}\``,
    ...(report.load.abortedReason ? [`- **提前停止**：${report.load.abortedReason}`] : []),
    '',
    '## 结论边界',
    '',
    '> 本报告只描述指定模型、上下文、工具和执行后端下的观测结果。最高档通过不自动等于生产安全容量；还需检查样本密度、恢复基线和重复批次。',
    '',
    ...report.findings.map((finding) => `- ${finding}`),
    '',
    '## 容量曲线',
    '',
    '|并发|波次/Run|成功/失败|Done P95|样本|进程CPU Max|cgroup CPU Max|EL Max|RSS Peak|Heap Peak|cgroup Peak|Anon/File/Slab Peak|可用内存 Min|Pending/Running Max|',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.tiers.map((tier) => {
      const metric = tier.metrics;
      return [
        tier.concurrency,
        `${tier.waves}/${tier.measuredRuns}`,
        `${tier.success}/${tier.failed}`,
        formatMs(tier.doneP95Ms),
        tier.sampleCount,
        formatPercent(metric.processCpuPercent?.max),
        formatPercent(metric.cgroupCpuPercent?.max),
        formatMs(metric.eventLoopDelayMaxMs?.max),
        formatMib(metric.rssBytes?.max),
        formatMib(metric.heapUsedBytes?.max),
        formatMib(metric.cgroupMemoryCurrentBytes?.max),
        `${formatMib(metric.cgroupAnonBytes?.max)}/${formatMib(metric.cgroupFileBytes?.max)}/${formatMib(metric.cgroupSlabReclaimableBytes?.max)}`,
        formatMib(metric.hostAvailableBytes?.min),
        `${formatNumber(metric.globalPendingRuns?.max)}/${formatNumber(metric.globalRunningRuns?.max)}`,
      ].join('|').replace(/^/, '|').concat('|');
    }),
    '',
    '## 压力与恢复信号',
    '',
    '|并发|RSS峰值增量|cgroup峰值增量|High事件|OOM/OOM Kill|CPU Throttle|准入暂停样本|告警|',
    '|---:|---:|---:|---:|---:|---:|---:|---|',
    ...report.tiers.map((tier) => [
      tier.concurrency,
      formatMib(tier.peakAboveBaseline.rssBytes),
      formatMib(tier.peakAboveBaseline.cgroupMemoryCurrentBytes),
      tier.memoryEventDelta.high ?? 0,
      `${tier.memoryEventDelta.oom ?? 0}/${tier.memoryEventDelta.oom_kill ?? 0}`,
      `${tier.cpuThrottleDelta.nr_throttled ?? 0}/${formatMs((tier.cpuThrottleDelta.throttled_usec ?? 0) / 1_000)}`,
      tier.admissionPausedSamples,
      tier.warnings.length ? tier.warnings.join('；') : '无',
    ].join('|').replace(/^/, '|').concat('|')),
    '',
    '## 判读原则',
    '',
    '- 进程RSS/Heap回答Node自身增长；cgroup Memory回答Worker及其子进程、文件缓存和内核记账。两者不能互相替代。',
    '- `file`和`slab_reclaimable`可回收，但持续增长、伴随PSI/High事件或可用内存下降时仍是容量风险。',
    '- P95在样本量不足20时只作描述性参考，不用于承诺SLA。',
    '- 出现Run失败、准入暂停、Event Loop 500ms尖峰、MemoryHigh或OOM时，该并发档不能直接作为安全值。',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function intervalOverlaps(sample: PerfSample, window: MeasurementWindow): boolean {
  const sampleEnd = Date.parse(sample.sampledAt);
  const sampleStart = sampleEnd - Math.max(1, sample.intervalMs ?? 0);
  const windowStart = Date.parse(window.startedAt);
  const windowEnd = Date.parse(window.completedAt);
  return sampleEnd >= windowStart && sampleStart <= windowEnd;
}

function peakAboveWindowBaselines(
  samples: PerfSample[],
  windows: MeasurementWindow[],
  path: string,
): number | undefined {
  const deltas = windows.flatMap((window) => {
    const startMs = Date.parse(window.startedAt);
    const before = samples
      .filter((sample) => Date.parse(sample.sampledAt) <= startMs)
      .at(-1);
    const activeValues = samples
      .filter((sample) => intervalOverlaps(sample, window))
      .flatMap((sample) => {
        const value = getNumber(sample, path);
        return value === undefined ? [] : [value];
      });
    const baseline = before ? getNumber(before, path) : undefined;
    return baseline === undefined || activeValues.length === 0
      ? []
      : [Math.max(...activeValues) - baseline];
  });
  return deltas.length > 0 ? Math.max(...deltas) : undefined;
}

function counterDeltasByWindows(
  samples: PerfSample[],
  windows: MeasurementWindow[],
  basePath: string,
  keys: string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const window of windows) {
    const startMs = Date.parse(window.startedAt);
    const endMs = Date.parse(window.completedAt);
    const before = samples.filter((sample) => Date.parse(sample.sampledAt) <= startMs).at(-1);
    const after = samples.find((sample) => Date.parse(sample.sampledAt) >= endMs);
    if (!before || !after) continue;
    for (const key of keys) {
      const start = getNumber(before, `${basePath}.${key}`);
      const end = getNumber(after, `${basePath}.${key}`);
      if (start === undefined || end === undefined) continue;
      totals[key] = (totals[key] ?? 0) + Math.max(0, end - start);
    }
  }
  return totals;
}

function summarizeNumbers(values: number[]): MetricSummary {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1),
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    first: values[0],
    last: values.at(-1),
    delta: (values.at(-1) ?? 0) - (values[0] ?? 0),
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1);
  return sortedValues[index] ?? 0;
}

function uniqueSamples(samples: PerfSample[]): PerfSample[] {
  const seen = new Set<string>();
  return samples.filter((sample) => {
    const key = `${sample.sampledAt}:${getNumber(sample, 'process.pid') ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getNumber(value: unknown, path: string): number | undefined {
  const resolved = getValue(value, path);
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : undefined;
}

function getValue(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function formatMib(bytes?: number): string {
  return bytes === undefined ? '—' : `${formatNumber(bytes / 1024 ** 2)}MiB`;
}

function formatMs(value?: number): string {
  return value === undefined ? '—' : `${formatNumber(value)}ms`;
}

function formatPercent(value?: number): string {
  return value === undefined ? '—' : `${formatNumber(value)}%`;
}

function formatNumber(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return String(Math.round(value * 100) / 100);
}

function defaultSibling(input: string, fileName: string): string {
  return resolve(dirname(resolve(input)), fileName);
}

function requiredArg(name: string): string {
  const value = argValue(name);
  if (!value) throw new Error(`缺少参数${name}`);
  return value;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

main().catch((error) => {
  console.error('[FAIL]', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
