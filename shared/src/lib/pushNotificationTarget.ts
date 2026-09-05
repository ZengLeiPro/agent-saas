/**
 * 系统推送落地目标的纯解析 —— iOS APNs 与 Web Push 共用同一份 payload 契约。
 *
 * 服务端下发的 payload 形如：
 *   `{ aps: { alert: { title, body }, sound: 'default' }, url: '/chat/<sessionId>' }`
 * 其中 `url` 始终是站内相对路径，取值只有三类：
 *   - `/chat/<sessionId>`：AskUser、审批、后台任务，以及有会话的 Cron 运行；
 *   - `/cron?jobId=<id>&runId=<id>`：无会话的 Cron 运行，落到任务详情；
 *   - 其它路径（Taskboard 等）：本函数不认，交给调用方按「不跳转」处理。
 *
 * 解析必须 fail closed：点击通知会直接触发导航，任何越权或畸形路径都返回 null，
 * 而不是拼一个「尽量像」的路由。绝对 URL、协议相对 URL、路径穿越、含 `/` 的
 * 标识符一律拒绝。
 */

export interface PushSessionTarget {
  kind: 'session';
  sessionId: string;
}

export interface PushCronTarget {
  kind: 'cron';
  jobId: string;
  runId?: string;
}

export type PushNotificationTarget = PushSessionTarget | PushCronTarget;

/** 标识符只允许落在单个路径段/查询值里：空、含 `/`、含 `..`、含控制字符都拒绝。 */
function safeIdentifier(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // 非法百分号编码
  }
  const value = decoded.trim();
  if (!value) return null;
  if (value.includes('/') || value.includes('\\')) return null;
  if (value.includes('..')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** 解析查询串（不含 `?`）为一层键值对；重复键取第一个。 */
function parseQuery(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = index < 0 ? pair : pair.slice(0, index);
    const value = index < 0 ? '' : pair.slice(index + 1);
    if (!key || Object.prototype.hasOwnProperty.call(params, key)) continue;
    params[key] = value;
  }
  return params;
}

/**
 * 从推送 payload 的 `data` 解析落地目标；无法确定目标时返回 null。
 */
export function parsePushNotificationTarget(data: unknown): PushNotificationTarget | null {
  if (!data || typeof data !== 'object') return null;
  const rawUrl = (data as { url?: unknown }).url;
  if (typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();
  // 只接受站内绝对路径；`//host/...` 是协议相对 URL，必须拒绝。
  if (!url.startsWith('/') || url.startsWith('//')) return null;

  const withoutHash = url.split('#')[0];
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? {} : parseQuery(withoutHash.slice(queryIndex + 1));
  // 不做「空段归一」：`/chat//x` 这类畸形路径直接拒绝，而不是悄悄修好。
  const rawSegments = path.split('/');
  if (rawSegments[0] !== '') return null;
  const segments = rawSegments.slice(1);
  if (segments.some((segment) => segment.length === 0)) return null;

  if (segments[0] === 'chat' && segments.length === 2) {
    const sessionId = safeIdentifier(segments[1]);
    return sessionId ? { kind: 'session', sessionId } : null;
  }
  if (segments[0] === 'cron' && segments.length === 1) {
    const jobId = safeIdentifier(query.jobId);
    if (!jobId) return null;
    const runId = safeIdentifier(query.runId);
    return runId ? { kind: 'cron', jobId, runId } : { kind: 'cron', jobId };
  }
  return null;
}
