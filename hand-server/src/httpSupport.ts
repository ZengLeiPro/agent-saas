import type { IncomingMessage, ServerResponse } from 'node:http';

/** 单请求 body 上限（与既有 handlers 行为一致，TASK-316 拆分时抽出共享）。 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(new Error(`body 超出上限 ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', rejectBody);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function truncate(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf-8');
  if (buf.length <= maxBytes) return value;
  return buf.slice(0, maxBytes).toString('utf-8') + `\n…[truncated ${buf.length - maxBytes} bytes]`;
}
