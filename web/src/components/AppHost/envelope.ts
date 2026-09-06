/**
 * §5.3 信封与来源校验（壳侧）。
 *
 * 移植自 `packages/ky-app-cli/assets/shell.html:433-448` 的 message 监听器，
 * 拆成纯函数以便逐条写测试：那段代码是壳唯一的信任边界，跨源 iframe 是全仓首例，
 * 任何一条判定写反都等于把 `postMessage` 通道开放给整个互联网。
 *
 * 判定顺序与 shell.html 一致，且**不可调整**：
 * 1. `event.origin === appOrigin`（精确串比，不做前缀 / 通配）；
 * 2. `event.source === iframe.contentWindow`（同源的另一个 iframe 也能发出同样的 origin，
 *    只比 origin 会被 `shell.html:416-419` 的 forger 打穿）；
 * 3. 信封形状 `{ ns:'ky', v:1, type:string }`；
 * 4. `type` 必须在 §5.4 的「子到壳」闭集里（壳自己发出的 type 从子端回来一律丢弃）。
 */
import {
  APP_TO_SHELL_MESSAGE_TYPES,
  MESSAGE_NAMESPACE,
  MESSAGE_VERSION,
  type AppToShellMessageType,
  type KyMessageEnvelope,
} from '@kaiyan/ky-app-contract/browser';

export type IncomingEnvelope = KyMessageEnvelope<AppToShellMessageType, unknown>;

/** 拒绝原因；`origin` / `source` 两类会落安全事件，其余只是噪音。 */
export type EnvelopeRejectReason = 'origin' | 'source' | 'shape' | 'namespace' | 'version' | 'type';

export type EnvelopeVerdict =
  { ok: true; envelope: IncomingEnvelope } | { ok: false; reason: EnvelopeRejectReason };

/** 只有这两类拒绝值得报安全事件：其余是页面上别的库在广播自己的消息。 */
export const SECURITY_RELEVANT_REJECTIONS: readonly EnvelopeRejectReason[] = ['origin', 'source'];

const APP_TO_SHELL = new Set<string>(APP_TO_SHELL_MESSAGE_TYPES);

export interface EnvelopeGateInput {
  /** 期望来源（安装实例的 `origin`）；未知时一律拒绝，不放行「先收再说」。 */
  appOrigin: string | null;
  /** 当前 iframe 的 contentWindow；未挂载时一律拒绝。 */
  frameWindow: Window | null;
}

export function classifyIncomingMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  gate: EnvelopeGateInput,
): EnvelopeVerdict {
  if (!gate.appOrigin || event.origin !== gate.appOrigin) return { ok: false, reason: 'origin' };
  if (!gate.frameWindow || event.source !== gate.frameWindow) {
    return { ok: false, reason: 'source' };
  }

  const data = event.data;
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'shape' };
  const record = data as Record<string, unknown>;
  if (record.ns !== MESSAGE_NAMESPACE) return { ok: false, reason: 'namespace' };
  if (record.v !== MESSAGE_VERSION) return { ok: false, reason: 'version' };
  if (typeof record.type !== 'string') return { ok: false, reason: 'shape' };
  if (!APP_TO_SHELL.has(record.type)) return { ok: false, reason: 'type' };
  if (record.id !== undefined && typeof record.id !== 'string') {
    return { ok: false, reason: 'shape' };
  }
  if (record.navId !== undefined && typeof record.navId !== 'string') {
    return { ok: false, reason: 'shape' };
  }

  return { ok: true, envelope: record as unknown as IncomingEnvelope };
}

/** 壳到子：构造信封。`payload` 为 undefined 时不写该键（与 shell.html:147-155 一致）。 */
export function buildOutgoingEnvelope(
  type: string,
  payload?: unknown,
  extra: { id?: string; navId?: string } = {},
): KyMessageEnvelope<string, unknown> {
  const envelope: KyMessageEnvelope<string, unknown> = {
    ns: MESSAGE_NAMESPACE,
    v: MESSAGE_VERSION,
    type,
  };
  if (extra.id !== undefined) envelope.id = extra.id;
  if (extra.navId !== undefined) envelope.navId = extra.navId;
  if (payload !== undefined) envelope.payload = payload;
  return envelope;
}
