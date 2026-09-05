/** 打被测项目的 HTTP 小工具：统一带 `X-KY-Request-Id`，并把响应体解析成 JSON。 */
import { HTTP_HEADERS } from '@kaiyan/ky-app-contract';

export interface CallInput {
  method?: string;
  path: string;
  /** `Authorization: Bearer <token>`。 */
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `X-KY-Request-Id`；`agent`/`platform` 的 SAT 必须用同一个值当 `rid`。 */
  requestId?: string;
  /** 走原始 fetch，不解析 JSON（例如 HTML 入口）。 */
  raw?: boolean;
}

export interface CallResult {
  status: number;
  headers: Headers;
  /** 解析成功时的 JSON；解析失败为 undefined。 */
  json?: unknown;
  text: string;
  /** 附录 D 的错误码（如果响应是错误结构）。 */
  errorCode?: string;
}

let requestCounter = 0;

/** 生成一个请求 id（同时用作 agent/platform SAT 的 `rid`）。 */
export function newRequestId(prefix = 'doctor'): string {
  requestCounter += 1;
  return `${prefix}-${String(Date.now())}-${String(requestCounter)}`;
}

export async function call(baseUrl: string, input: CallInput): Promise<CallResult> {
  const headers: Record<string, string> = { ...input.headers };
  if (input.token !== undefined) headers.authorization = `Bearer ${input.token}`;
  if (input.requestId !== undefined) headers[HTTP_HEADERS.requestId] = input.requestId;
  const method = input.method ?? 'GET';
  if (input.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl}${input.path}`, {
    method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: 'manual',
  });
  const text = await response.text();
  let json: unknown;
  if (!input.raw) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const errorCode =
    typeof json === 'object' && json !== null && 'error' in json
      ? ((json as { error?: { code?: string } }).error?.code ?? undefined)
      : undefined;
  return {
    status: response.status,
    headers: response.headers,
    ...(json === undefined ? {} : { json }),
    text,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/** 断言帮手：不满足即抛，错误信息里带上状态码与响应体片段。 */
export function expectStatus(result: CallResult, expected: number | number[], what: string): void {
  const list = Array.isArray(expected) ? expected : [expected];
  if (list.includes(result.status)) return;
  throw new Error(
    `${what}：期望 HTTP ${list.join('/')}，实际 ${String(result.status)}` +
      `${result.errorCode === undefined ? '' : ` code=${result.errorCode}`}` +
      ` body=${result.text.slice(0, 200)}`,
  );
}

/** 断言附录 D 的错误码。 */
export function expectErrorCode(result: CallResult, expected: string, what: string): void {
  if (result.errorCode === expected) return;
  throw new Error(
    `${what}：期望错误码 ${expected}，实际 ${result.errorCode ?? '（无）'}（HTTP ${String(result.status)}）`,
  );
}

/** 通用断言。 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * 用 `node:http` 发一个**不经 URL 规范化**的请求。
 *
 * `fetch` 会按 WHATWG 规则把 `..` / `\` 先规范化掉，而 §9.3-3 恰恰要求把这些原样送到
 * 服务端去看它自己怎么判。所以路径穿越类用例一律走这里。
 */
export async function rawCall(
  baseUrl: string,
  rawPath: string,
  init: { method?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; errorCode?: string }> {
  const { request } = await import('node:http');
  const target = new URL(baseUrl);
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;

  return new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        host: target.hostname,
        port: target.port,
        method: init.method ?? 'GET',
        path: rawPath,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let errorCode: string | undefined;
          try {
            errorCode = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
          } catch {
            errorCode = undefined;
          }
          resolve({
            status: response.statusCode ?? 0,
            text,
            ...(errorCode === undefined ? {} : { errorCode }),
          });
        });
      },
    );
    clientRequest.on('error', reject);
    clientRequest.end();
  });
}
