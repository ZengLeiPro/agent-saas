/**
 * Azeroth 透明反向代理路由
 *
 * 把所有 `/api/azeroth/*` 请求透传到 ky-azeroth 后端：
 *   - 从 `req.user.username` 取 agent 用户名（由全局 JWT auth middleware 注入）
 *   - 查 `azeroth-tokens.json` 拿对应员工的 PAT
 *   - 替换 Authorization 头为 `Bearer <PAT>`
 *   - method/path/query/body 全透传，支持 multipart 上传流式 pipe
 *   - 响应 status/headers/body 全透传
 *
 * 关键依赖：必须配合 server/src/index.ts 中"path-skip 版本的 express.json()"，
 * 否则 JSON 请求体会被全局 parser 提前消费，无法 stream 透传。
 *
 * 新增 azeroth 接口零代码：mobile/web 直接 fetch `/api/azeroth/<任意 azeroth 路径>` 即可。
 */

import { Router } from 'express';
import { Readable } from 'node:stream';
import { resolveAzerothInjection } from '../integrations/azeroth/tokens.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('azeroth-proxy');

// 默认指向生产 azeroth FC 域名，dev/test 可通过环境变量覆盖
// （e.g. `AZEROTH_PROXY_BASE_URL=http://localhost:3000/api/v1` 走本地 azeroth）
const UPSTREAM_BASE = process.env['AZEROTH_PROXY_BASE_URL']
  || 'https://fc.kaiyan.net/ky-azeroth/api/v1';

// HTTP hop-by-hop headers 不应透传
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length', // 由 fetch 自动重算
]);

export function createAzerothProxyRouter(): Router {
  const router = Router();

  router.all('/azeroth/*', async (req, res) => {
    const username = req.user?.username;
    const tenantId = req.user?.tenantId;
    if (!username || !tenantId) {
      // 全局 auth middleware 正常情况下不会让未认证请求落到这里
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // PR 6 修 P0-6：按 (tenantId, username) 二级查 PAT
    const injection = resolveAzerothInjection(tenantId, username);
    if (!injection) {
      logger.warn('未配置 azeroth PAT', { tenantId, username });
      res.status(403).json({
        error: 'No azeroth token for user',
        message: `用户 ${username} 未配置 azeroth 访问凭证，请联系管理员`,
      });
      return;
    }

    // 提取通配部分作为 azeroth 子路径
    // req.params[0] 在 Express 4 中等于 `/azeroth/*` 的 `*` 部分
    const subPath = (req.params as { 0?: string })[0] ?? '';
    const queryIdx = req.originalUrl.indexOf('?');
    const queryString = queryIdx >= 0 ? req.originalUrl.slice(queryIdx) : '';
    const upstreamUrl = `${UPSTREAM_BASE.replace(/\/$/, '')}/${subPath}${queryString}`;

    // 拷贝请求头，剥离 hop-by-hop 与原 Authorization，写入 PAT
    const forwardHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'authorization' || lower === 'cookie') continue;
      forwardHeaders[name] = Array.isArray(value) ? value.join(',') : value;
    }
    forwardHeaders['authorization'] = `Bearer ${injection.token}`;

    // 客户端断开时 abort upstream
    //
    // ⚠️ 必须用 res.on('close') 而非 req.on('close')：
    //   - req('close') 在 Node 16+ 行为变更后，body 流读完也会触发，
    //     不只是真实连接断开。我们 buffer body 时 `for await req` 读完后
    //     立刻触发 req 'close' → controller.abort() → fetch 才 1ms 就死。
    //     之前 multipart 上传 1.05MB 复现为"上传失败: 服务端返回空响应"。
    //   - res('close') 仅在 response 被外部关闭（客户端断开）时触发，
    //     是 Express 推荐的客户端断开检测方式。
    const controller = new AbortController();
    const reqStartTs = Date.now();
    const onResClose = () => {
      if (res.writableEnded) return; // 正常 end 不算客户端断开
      logger.info('client res closed (client disconnected)', {
        url: upstreamUrl,
        method: req.method,
        elapsedMs: Date.now() - reqStartTs,
      });
      controller.abort();
    };
    res.once('close', onResClose);

    const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    const isMultipart = contentType.startsWith('multipart/');
    // 全部请求都先 buffer 再 fetch，让 fetch 自动算 Content-Length。
    // 上游 azeroth 跑在阿里云 FC 上，FC 网关对 chunked Transfer-Encoding 不稳定
    // ——历史问题：JSON POST 的 body 会被吞导致 502/空响应（commit b4e8e866 已修
    // 非 multipart）；multipart 上传同样会被吞，触发前端 `resp.json()` 抛
    // "Unexpected end of input"。azeroth /upload 单文件上限 10MB，buffer 进内存
    // 完全可接受。
    let upstreamBody: BodyInit | undefined;
    if (hasBody) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      upstreamBody = Buffer.concat(chunks);
    }

    if (isMultipart) {
      logger.info('azeroth multipart upstream req', {
        url: upstreamUrl,
        method: req.method,
        contentType,
        bodyBytes: upstreamBody instanceof Buffer ? upstreamBody.length : 0,
      });
    }

    const fetchStartTs = Date.now();
    if (isMultipart) {
      logger.info('azeroth multipart fetch start', { url: upstreamUrl });
    }
    try {
      const upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: upstreamBody,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (isMultipart) {
        logger.info('azeroth multipart fetch returned', {
          url: upstreamUrl,
          elapsedMs: Date.now() - fetchStartTs,
          status: upstreamResp.status,
        });
      }

      // upstream 非 2xx 时记录详情，便于排查
      if (upstreamResp.status >= 400) {
        logger.warn('azeroth upstream non-2xx', {
          url: upstreamUrl,
          method: req.method,
          status: upstreamResp.status,
          contentType: upstreamResp.headers.get('content-type'),
        });
      }

      // multipart 上传：buffer 上游响应一次性写回，避免 stream pipe 中途出错
      // 导致客户端拿到不完整 body（前端 JSON.parse 就会炸 "Unexpected end of input"）。
      // 同时记录详细日志便于排查 FC 网关行为。
      if (isMultipart) {
        const respBuf = Buffer.from(await upstreamResp.arrayBuffer());
        logger.info('azeroth multipart upstream resp', {
          url: upstreamUrl,
          status: upstreamResp.status,
          contentType: upstreamResp.headers.get('content-type'),
          contentLength: upstreamResp.headers.get('content-length'),
          bodyBytes: respBuf.length,
          bodyPreview: respBuf.length > 0 ? respBuf.toString('utf8').slice(0, 200) : '(empty)',
        });
        res.status(upstreamResp.status);
        upstreamResp.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (HOP_BY_HOP.has(lower)) return;
          if (lower === 'set-cookie') return;
          if (lower === 'content-length') return; // 用 buf 实际长度
          res.setHeader(key, value);
        });
        res.setHeader('content-length', respBuf.length.toString());
        res.end(respBuf);
        return;
      }

      res.status(upstreamResp.status);

      upstreamResp.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower)) return;
        // 不透传 set-cookie（azeroth 的 session cookie 跟 agent 不相关）
        if (lower === 'set-cookie') return;
        res.setHeader(key, value);
      });

      if (upstreamResp.body) {
        const nodeStream = Readable.fromWeb(upstreamResp.body as unknown as import('node:stream/web').ReadableStream);
        nodeStream.on('error', (err) => {
          logger.warn('upstream response stream error', { url: upstreamUrl, err: String(err) });
          if (!res.headersSent) res.status(502);
          res.end();
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      res.removeListener('close', onResClose);
      // 客户端主动 abort 不算错误
      if ((err as { name?: string })?.name === 'AbortError') {
        logger.info('azeroth upstream aborted (client closed)', {
          url: upstreamUrl,
          method: req.method,
          fetchElapsedMs: Date.now() - fetchStartTs,
          isMultipart,
        });
        if (!res.headersSent) res.end();
        return;
      }
      logger.warn('azeroth upstream error', {
        url: upstreamUrl,
        method: req.method,
        fetchElapsedMs: Date.now() - fetchStartTs,
        isMultipart,
        err: String(err),
      });
      if (!res.headersSent) {
        res.status(502).json({
          error: 'azeroth upstream unreachable',
          cause: String(err),
        });
      } else {
        res.end();
      }
    } finally {
      res.removeListener('close', onResClose);
    }
  });

  return router;
}
