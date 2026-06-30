import type { ChannelType } from '../types/index.js';
import type { DispatchMetrics, DispatchMetricsReporter } from './types.js';

export interface DispatchMetricsSnapshot {
  totalRuns: number;
  totalErrors: number;
  avgDurationMs: number;
  avgFirstEventLatencyMs: number | null;
  byChannel: Partial<Record<ChannelType, { runs: number; errors: number }>>;
  lastRun?: DispatchMetrics;
}

/**
 * 内存态调度指标聚合器：用于健康检查或后续接入外部监控。
 */
export class DispatchMetricsStore {
  private totalRuns = 0;
  private totalErrors = 0;
  private totalDurationMs = 0;
  private firstLatencySamples = 0;
  private totalFirstLatencyMs = 0;
  private readonly byChannel = new Map<ChannelType, { runs: number; errors: number }>();
  private lastRun: DispatchMetrics | undefined;

  readonly report: DispatchMetricsReporter = (metrics) => {
    this.totalRuns += 1;
    this.totalErrors += metrics.errorCount;
    this.totalDurationMs += metrics.durationMs;
    if (metrics.firstEventLatencyMs !== null) {
      this.firstLatencySamples += 1;
      this.totalFirstLatencyMs += metrics.firstEventLatencyMs;
    }

    const current = this.byChannel.get(metrics.channel) ?? { runs: 0, errors: 0 };
    current.runs += 1;
    current.errors += metrics.errorCount;
    this.byChannel.set(metrics.channel, current);
    this.lastRun = metrics;
  };

  getSnapshot(): DispatchMetricsSnapshot {
    const byChannel: DispatchMetricsSnapshot['byChannel'] = {};
    for (const [channel, counters] of this.byChannel.entries()) {
      byChannel[channel] = { ...counters };
    }

    return {
      totalRuns: this.totalRuns,
      totalErrors: this.totalErrors,
      avgDurationMs: this.totalRuns > 0 ? this.totalDurationMs / this.totalRuns : 0,
      avgFirstEventLatencyMs:
        this.firstLatencySamples > 0
          ? this.totalFirstLatencyMs / this.firstLatencySamples
          : null,
      byChannel,
      lastRun: this.lastRun,
    };
  }
}
