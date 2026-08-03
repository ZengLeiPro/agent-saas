import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { WebSocket } from 'ws';

type DownstreamEvent = Record<string, unknown> & {
  type?: string;
  client_msg_id?: string;
  sessionId?: string;
  streamId?: string;
};

type ScenarioName = 'model-short' | 'context-replay' | 'tool-read' | 'tool-shell' | 'subagent' | 'mixed';

interface Scenario {
  name: Exclude<ScenarioName, 'mixed'>;
  description: string;
  setupMessages: string[];
  measuredMessage: string;
  allowedTools: string[];
}

interface TurnResult {
  clientMsgId: string;
  sessionId: string;
  streamId?: string;
  ackMs?: number;
  sessionMs?: number;
  firstProgressMs?: number;
  doneMs: number;
  textBytes: number;
  toolCalls: Record<string, number>;
  approvals: number;
  error?: string;
}

interface MeasurementWindow {
  wave: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface TierResult {
  concurrency: number;
  waves: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  measurementWindows: MeasurementWindow[];
  scenarioCounts: Record<string, number>;
  success: number;
  failed: number;
  errorRate: number;
  latencyMs: {
    ackP50?: number;
    ackP95?: number;
    firstProgressP50?: number;
    firstProgressP95?: number;
    doneP50: number;
    doneP95: number;
    doneMax: number;
  };
  turns: TurnResult[];
}

interface PendingTurn {
  clientMsgId: string;
  startedAtMs: number;
  allowedTools: Set<string>;
  sessionId?: string;
  streamId?: string;
  ackAtMs?: number;
  sessionAtMs?: number;
  firstProgressAtMs?: number;
  textBytes: number;
  toolCalls: Record<string, number>;
  approvals: number;
  resolve: (result: TurnResult) => void;
  timer: NodeJS.Timeout;
}

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3200';
const DEFAULT_TIERS = [1, 2, 4, 8, 16];
const MAX_SUPPORTED_CONCURRENCY = 16;

const SCENARIOS: Record<Exclude<ScenarioName, 'mixed'>, Scenario> = {
  'model-short': {
    name: 'model-short',
    description: '纯模型短回复，隔离模型等待与基础调度成本',
    setupMessages: [],
    measuredMessage: '这是Runtime Worker容量探针。禁止调用任何工具，只回复：BENCH_MODEL_OK',
    allowedTools: [],
  },
  'context-replay': {
    name: 'context-replay',
    description: '预填约12KiB用户历史后执行新一轮，观察回放和上下文构造放大',
    setupMessages: Array.from({ length: 3 }, (_, index) => (
      `上下文预填${index + 1}/3。记住下列探针文本，不要调用工具，只回复 PREFILL_${index + 1}_OK。\n`
      + deterministicPayload(index, 4_096)
    )),
    measuredMessage: '这是长上下文Runtime Worker容量探针。不要调用工具，只回复：BENCH_CONTEXT_OK',
    allowedTools: [],
  },
  'tool-read': {
    name: 'tool-read',
    description: '每个Run执行一次只读Workspace工具，覆盖文件访问和工具结果事件',
    setupMessages: [],
    measuredMessage: [
      '这是Runtime Worker只读工具容量探针。',
      '必须且只允许调用一次Read工具读取MEMORY.md前20行；无论文件是否存在，工具结束后只回复：BENCH_READ_OK。',
      '禁止调用其他工具，禁止修改任何文件。',
    ].join('\n'),
    allowedTools: ['Read'],
  },
  'tool-shell': {
    name: 'tool-shell',
    description: '每个Run执行一次无副作用Shell，覆盖Sandbox分配和exec链路',
    setupMessages: [],
    measuredMessage: [
      '这是Runtime Worker Shell容量探针。',
      '必须且只允许调用一次Shell，command精确为：printf BENCH_SHELL_OK，timeoutMs为30000，mode为foreground。',
      '禁止调用其他工具；命令结束后只回复：BENCH_SHELL_OK。',
    ].join('\n'),
    allowedTools: ['Shell'],
  },
  subagent: {
    name: 'subagent',
    description: '每个前台Run派生一个前台子Agent，覆盖共享全局并发池的嵌套负载',
    setupMessages: [],
    measuredMessage: [
      '这是Runtime Worker子Agent容量探针。',
      '必须且只允许调用一次Agent工具：mode=foreground、agent_type=general，子Agent只回复SUBAGENT_OK且不得调用任何工具。',
      '子Agent完成后只回复：BENCH_SUBAGENT_OK。',
    ].join('\n'),
    allowedTools: ['Agent'],
  },
};

class BenchmarkSocket {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly pendingBySession = new Map<string, PendingTurn>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly timeoutMs: number,
  ) {
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', (error) => this.failAll(`WebSocket error: ${error.message}`));
    ws.on('close', () => this.failAll('WebSocket closed'));
  }

  static connect(baseUrl: string, token: string, timeoutMs: number): Promise<BenchmarkSocket> {
    return new Promise((resolveConnect, rejectConnect) => {
      const url = wsUrl(baseUrl, token);
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        rejectConnect(new Error(`WebSocket连接超时: ${url.origin}${url.pathname}`));
      }, 15_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolveConnect(new BenchmarkSocket(ws, timeoutMs));
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        rejectConnect(error);
      });
    });
  }

  sendTurn(input: {
    message: string;
    sessionId?: string;
    model?: string;
    executionTarget?: string;
    allowedTools: string[];
  }): Promise<TurnResult> {
    const clientMsgId = `worker-bench-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolveTurn) => {
      const startedAtMs = Date.now();
      const pending: PendingTurn = {
        clientMsgId,
        startedAtMs,
        allowedTools: new Set(input.allowedTools),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        textBytes: 0,
        toolCalls: {},
        approvals: 0,
        resolve: resolveTurn,
        timer: setTimeout(() => {
          if (pending.sessionId) {
            this.ws.send(JSON.stringify({ action: 'abort', sessionId: pending.sessionId }));
          }
          this.finish(pending, `Run超时（${this.timeoutMs}ms）`);
        }, this.timeoutMs),
      };
      this.pending.set(clientMsgId, pending);
      if (input.sessionId) this.pendingBySession.set(input.sessionId, pending);
      this.ws.send(JSON.stringify({
        action: 'chat',
        client_msg_id: clientMsgId,
        message: input.message,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
      }));
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let event: DownstreamEvent;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const record = parsed as Record<string, unknown>;
      event = record.data && typeof record.data === 'object'
        ? record.data as DownstreamEvent
        : record as DownstreamEvent;
    } catch {
      return;
    }
    const pending = this.resolvePending(event);
    if (!pending) return;
    const now = Date.now();
    if (event.type === 'chat_ack' && !pending.ackAtMs) pending.ackAtMs = now;
    if (event.type === 'session' && event.sessionId) {
      pending.sessionId = event.sessionId;
      pending.sessionAtMs ??= now;
      this.pendingBySession.set(event.sessionId, pending);
    }
    if (event.type === 'stream_id' && event.streamId) pending.streamId = event.streamId;
    if (isProgressEvent(event.type) && !pending.firstProgressAtMs) pending.firstProgressAtMs = now;
    if (event.type === 'text_delta') {
      pending.textBytes += Buffer.byteLength(String(event.content ?? ''), 'utf8');
    }
    if (event.type === 'tool_start' || event.type === 'tool_call') {
      const toolName = String(event.toolName ?? event.name ?? 'unknown');
      pending.toolCalls[toolName] = (pending.toolCalls[toolName] ?? 0) + 1;
    }
    if (event.type === 'permission_request') {
      this.handlePermissionRequest(pending, event);
      return;
    }
    if (event.type === 'chat_rejected' || event.type === 'error') {
      this.finish(pending, String(event.reason ?? event.error ?? event.message ?? event.type));
      return;
    }
    if (event.type === 'done') {
      this.finish(pending, event.error ? String(event.error) : undefined);
    }
  }

  private handlePermissionRequest(pending: PendingTurn, event: DownstreamEvent): void {
    const toolName = String(event.toolName ?? '');
    const interactionId = String(event.interactionId ?? '');
    const sessionId = String(event.sessionId ?? pending.sessionId ?? '');
    if (!interactionId || !sessionId) {
      this.finish(pending, 'permission_request缺少interactionId或sessionId');
      return;
    }
    const allow = pending.allowedTools.has(toolName);
    pending.approvals += 1;
    this.ws.send(JSON.stringify({
      action: 'respond',
      sessionId,
      interactionId,
      allow,
      message: allow
        ? `Runtime Worker benchmark允许安全工具：${toolName}`
        : `Runtime Worker benchmark拒绝非场景工具：${toolName}`,
    }));
    if (!allow) this.finish(pending, `模型请求了场景外工具：${toolName}`);
  }

  private resolvePending(event: DownstreamEvent): PendingTurn | undefined {
    if (event.client_msg_id) return this.pending.get(event.client_msg_id);
    if (event.sessionId) return this.pendingBySession.get(event.sessionId);
    return undefined;
  }

  private finish(pending: PendingTurn, error?: string): void {
    if (!this.pending.has(pending.clientMsgId)) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.clientMsgId);
    if (pending.sessionId) this.pendingBySession.delete(pending.sessionId);
    const completedAtMs = Date.now();
    pending.resolve({
      clientMsgId: pending.clientMsgId,
      sessionId: pending.sessionId ?? '',
      ...(pending.streamId ? { streamId: pending.streamId } : {}),
      ...(pending.ackAtMs ? { ackMs: pending.ackAtMs - pending.startedAtMs } : {}),
      ...(pending.sessionAtMs ? { sessionMs: pending.sessionAtMs - pending.startedAtMs } : {}),
      ...(pending.firstProgressAtMs ? { firstProgressMs: pending.firstProgressAtMs - pending.startedAtMs } : {}),
      doneMs: completedAtMs - pending.startedAtMs,
      textBytes: pending.textBytes,
      toolCalls: pending.toolCalls,
      approvals: pending.approvals,
      ...(error ? { error } : {}),
    });
  }

  private failAll(message: string): void {
    for (const pending of [...this.pending.values()]) this.finish(pending, message);
  }
}

async function main(): Promise<void> {
  const baseUrl = argValue('--base-url') ?? DEFAULT_BASE_URL;
  const scenarioName = (argValue('--scenario') ?? 'mixed') as ScenarioName;
  if (!(scenarioName === 'mixed' || scenarioName in SCENARIOS)) {
    throw new Error(`未知场景：${scenarioName}`);
  }
  const tiers = parseTiers(argValue('--tiers'));
  const timeoutMs = positiveIntegerArg('--timeout-ms', 10 * 60_000);
  const settleMs = nonNegativeIntegerArg('--settle-ms', 30_000);
  const waves = positiveIntegerArg('--waves', 3);
  const waveGapMs = nonNegativeIntegerArg('--wave-gap-ms', 5_000);
  const maxErrorRate = numberArg('--max-error-rate', 0);
  const model = argValue('--model');
  const executionTarget = argValue('--execution-target');
  const tokenEnv = argValue('--token-env') ?? 'AGENT_SAAS_BENCH_TOKEN';
  const output = resolve(argValue('--output') ?? defaultOutputPath());
  const execute = hasFlag('--execute');

  assertSafety(baseUrl, tiers, execute);
  const plan = {
    baseUrl: redactUrl(baseUrl),
    scenario: scenarioName,
    tiers,
    timeoutMs,
    settleMs,
    waves,
    waveGapMs,
    measuredRuns: tiers.reduce((total, concurrency) => total + concurrency * waves, 0),
    maxErrorRate,
    model: model ?? '(服务端默认)',
    executionTarget: executionTarget ?? '(服务端默认)',
    output,
  };
  console.log('[plan]', JSON.stringify(plan, null, 2));
  if (!execute) {
    console.log('[DRY-RUN] 未发送任何Run；加 --execute 后才会执行。');
    return;
  }

  const token = process.env[tokenEnv]?.trim();
  if (!token) throw new Error(`缺少环境变量 ${tokenEnv}；token不会接受CLI参数，避免进入shell历史和进程列表。`);
  await assertHealthy(baseUrl);
  const socket = await BenchmarkSocket.connect(baseUrl, token, timeoutMs);
  const benchmarkStartedAt = new Date().toISOString();
  const tierResults: TierResult[] = [];
  let abortedReason: string | undefined;

  try {
    for (const concurrency of tiers) {
      await assertHealthy(baseUrl);
      const tierTurns: TurnResult[] = [];
      const tierScenarios: Scenario[] = [];
      const measurementWindows: MeasurementWindow[] = [];
      let tierStopped = false;

      for (let wave = 1; wave <= waves; wave += 1) {
        const assignments = Array.from({ length: concurrency }, (_, index) => resolveScenario(scenarioName, index));
        console.log(`[tier ${concurrency} wave ${wave}/${waves}] 准备${concurrency}个独立Session，场景=${summarizeScenarios(assignments)}`);
        const sessions = await prepareSessions(socket, assignments, model, executionTarget);
        if (settleMs > 0 && assignments.some((scenario) => scenario.setupMessages.length > 0)) {
          await sleep(settleMs);
        }

        const startedAtMs = Date.now();
        console.log(`[tier ${concurrency} wave ${wave}/${waves}] 同步发起${concurrency}个测量Run`);
        const turns = await Promise.all(assignments.map((scenario, index) => socket.sendTurn({
          message: scenario.measuredMessage,
          sessionId: sessions[index],
          model,
          executionTarget,
          allowedTools: scenario.allowedTools,
        })));
        const completedAtMs = Date.now();
        tierTurns.push(...turns);
        tierScenarios.push(...assignments);
        measurementWindows.push({
          wave,
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
        });
        const waveErrors = turns.filter((turn) => turn.error).length;
        console.log(`[tier ${concurrency} wave ${wave}/${waves}] success=${turns.length - waveErrors} failed=${waveErrors}`);
        if ((waveErrors / Math.max(1, turns.length)) > maxErrorRate) {
          tierStopped = true;
          break;
        }
        if (!(await isHealthy(baseUrl))) {
          tierStopped = true;
          break;
        }
        if (wave < waves && waveGapMs > 0) await sleep(waveGapMs);
      }

      const result = summarizeTier(concurrency, measurementWindows, tierScenarios, tierTurns);
      tierResults.push(result);
      console.log(`[tier ${concurrency}] waves=${result.waves} success=${result.success} failed=${result.failed} doneP95=${result.latencyMs.doneP95}ms errorRate=${result.errorRate}`);
      await writeReport(output, {
        schemaVersion: 1,
        benchmarkStartedAt,
        benchmarkCompletedAt: new Date().toISOString(),
        plan,
        tiers: tierResults,
        ...(abortedReason ? { abortedReason } : {}),
      });

      if (tierStopped || result.errorRate > maxErrorRate) {
        abortedReason = `并发${concurrency}在第${result.waves}波触发停止：错误率${result.errorRate}，阈值${maxErrorRate}`;
        console.error(`[STOP] ${abortedReason}`);
        break;
      }
      if (settleMs > 0) await sleep(settleMs);
    }
  } finally {
    socket.close();
  }

  await writeReport(output, {
    schemaVersion: 1,
    benchmarkStartedAt,
    benchmarkCompletedAt: new Date().toISOString(),
    plan,
    tiers: tierResults,
    ...(abortedReason ? { abortedReason } : {}),
  });
  console.log(`[report] ${output}`);
  if (abortedReason) process.exitCode = 2;
}

async function prepareSessions(
  socket: BenchmarkSocket,
  scenarios: Scenario[],
  model?: string,
  executionTarget?: string,
): Promise<Array<string | undefined>> {
  const sessions: Array<string | undefined> = new Array(scenarios.length).fill(undefined);
  const maxSetupTurns = Math.max(0, ...scenarios.map((scenario) => scenario.setupMessages.length));
  for (let turnIndex = 0; turnIndex < maxSetupTurns; turnIndex += 1) {
    const results = await Promise.all(scenarios.map(async (scenario, index) => {
      const message = scenario.setupMessages[turnIndex];
      if (!message) return undefined;
      return socket.sendTurn({
        message,
        sessionId: sessions[index],
        model,
        executionTarget,
        allowedTools: [],
      });
    }));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (!result) continue;
      if (result.error) throw new Error(`Session预填失败（VU=${index + 1} turn=${turnIndex + 1}）：${result.error}`);
      if (!result.sessionId) throw new Error(`Session预填未返回sessionId（VU=${index + 1}）`);
      sessions[index] = result.sessionId;
    }
  }
  return sessions;
}

function summarizeTier(
  concurrency: number,
  measurementWindows: MeasurementWindow[],
  scenarios: Scenario[],
  turns: TurnResult[],
): TierResult {
  if (measurementWindows.length === 0 || turns.length === 0) {
    throw new Error(`并发${concurrency}没有产生测量结果`);
  }
  const startedAtMs = Date.parse(measurementWindows[0]!.startedAt);
  const completedAtMs = Date.parse(measurementWindows.at(-1)!.completedAt);
  const failed = turns.filter((turn) => turn.error).length;
  const ack = turns.flatMap((turn) => turn.ackMs === undefined ? [] : [turn.ackMs]);
  const firstProgress = turns.flatMap((turn) => turn.firstProgressMs === undefined ? [] : [turn.firstProgressMs]);
  const done = turns.map((turn) => turn.doneMs);
  return {
    concurrency,
    waves: measurementWindows.length,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: measurementWindows.reduce((total, window) => total + window.durationMs, 0),
    measurementWindows,
    scenarioCounts: countValues(scenarios.map((scenario) => scenario.name)),
    success: turns.length - failed,
    failed,
    errorRate: round(failed / Math.max(1, turns.length), 4),
    latencyMs: {
      ...(ack.length ? { ackP50: percentile(ack, 50), ackP95: percentile(ack, 95) } : {}),
      ...(firstProgress.length
        ? { firstProgressP50: percentile(firstProgress, 50), firstProgressP95: percentile(firstProgress, 95) }
        : {}),
      doneP50: percentile(done, 50),
      doneP95: percentile(done, 95),
      doneMax: Math.max(...done),
    },
    turns,
  };
}

function resolveScenario(name: ScenarioName, index: number): Scenario {
  if (name !== 'mixed') return SCENARIOS[name];
  const order: Array<Exclude<ScenarioName, 'mixed'>> = [
    'model-short',
    'context-replay',
    'tool-read',
    'tool-shell',
    'subagent',
  ];
  return SCENARIOS[order[index % order.length]!];
}

function parseTiers(raw?: string): number[] {
  const tiers = raw ? raw.split(',').map((value) => Number(value.trim())) : DEFAULT_TIERS;
  if (tiers.length === 0 || tiers.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`--tiers必须是正整数列表，例如1,2,4,8,16；实际=${raw ?? ''}`);
  }
  if (Math.max(...tiers) > MAX_SUPPORTED_CONCURRENCY) {
    throw new Error(`单次压测最多${MAX_SUPPORTED_CONCURRENCY}并发；提高上限必须修改脚本并重新审查停止条件。`);
  }
  return [...new Set(tiers)].sort((a, b) => a - b);
}

function assertSafety(baseUrl: string, tiers: number[], execute: boolean): void {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--base-url仅允许http/https');
  if (!execute) return;
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (!local) {
    const confirmedHost = argValue('--confirm-host');
    if (confirmedHost !== url.hostname) {
      throw new Error(`远端压测必须显式传 --confirm-host=${url.hostname}；实际=${confirmedHost ?? '(未提供)'}`);
    }
  }
  if (Math.max(...tiers) >= 8 && !hasFlag('--confirm-high-concurrency')) {
    throw new Error('包含8或16并发时必须额外传 --confirm-high-concurrency');
  }
}

async function assertHealthy(baseUrl: string): Promise<void> {
  if (!(await isHealthy(baseUrl))) throw new Error(`服务健康检查失败：${redactUrl(baseUrl)}/api/health`);
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(10_000) });
    const data = await response.json().catch(() => ({})) as { status?: string };
    return response.ok && data.status === 'ok';
  } catch {
    return false;
  }
}

async function writeReport(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function wsUrl(baseUrl: string, token: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('token', token);
  return url;
}

function redactUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function deterministicPayload(seed: number, bytes: number): string {
  const unit = `PERF_CONTEXT_${seed}_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function defaultOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = timestamp.slice(0, 8);
  return resolve(PROJECT_ROOT, 'assets', day, `Worker并发压测-${timestamp}.json`);
}

function summarizeScenarios(scenarios: Scenario[]): string {
  return Object.entries(countValues(scenarios.map((scenario) => scenario.name)))
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function isProgressEvent(type?: string): boolean {
  return type === 'text_delta'
    || type === 'tool_start'
    || type === 'tool_call'
    || type === 'thinking'
    || type === 'permission_request';
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

function positiveIntegerArg(name: string, fallback: number): number {
  const value = Number(argValue(name) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}必须是正整数`);
  return value;
}

function nonNegativeIntegerArg(name: string, fallback: number): number {
  const value = Number(argValue(name) ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}必须是非负整数`);
  return value;
}

function numberArg(name: string, fallback: number): number {
  const value = Number(argValue(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name}必须在0到1之间`);
  return value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

main().catch((error) => {
  console.error('[FAIL]', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
