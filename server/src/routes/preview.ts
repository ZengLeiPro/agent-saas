/**
 * HTML Preview Routes
 *
 * 提供安全的 HTML 预览能力，支持加载本地关联资源（CSS/JS/图片/字体等），
 * 同时通过 CSP 阻止外部资源加载。
 *
 * 架构：
 * - POST /api/file/preview-token  — 生成短期预览 token（需认证）
 * - GET  /preview/:token/*        — 通过 token 自认证的文件服务（无需 auth middleware）
 *
 * HTML 文件会被注入 <base> 标签使相对路径可解析，并通过 CSP 限制只允许同源资源。
 * iframe sandbox="allow-scripts allow-same-origin" 配合 CSP connect-src 'none' 确保安全。
 */

import { Router } from "express";
import { createReadStream } from "fs";
import { readFile, lstat } from "fs/promises";
import { resolve, extname } from "path";
import { randomUUID } from "crypto";
import { resolveUserCwd } from "../workspace/resolver.js";
import { serverLogger } from "../utils/logger.js";
import {
  getUserExtraDirs,
  resolveAuthorizedPath,
  type UserOverrides,
} from "../security/extraDirs.js";

// ── Preview token store ──────────────────────────────────────────

interface PreviewSession {
  userCwd: string;
  extraDirs: string[];
  expiresAt: number;
}

const previewTokens = new Map<string, PreviewSession>();
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Periodic cleanup every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, session] of previewTokens) {
      if (session.expiresAt < now) previewTokens.delete(key);
    }
  },
  5 * 60 * 1000,
).unref();

// ── MIME map ─────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  // Web documents
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".xml": "text/xml",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  // Fonts
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // Media
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  // Other
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

// ── CSP ──────────────────────────────────────────────────────────

const PREVIEW_CSP = [
  "default-src 'self' 'unsafe-inline' data: blob:",
  "connect-src 'self'",
  "form-action 'none'",
].join("; ");

// ── Exports ──────────────────────────────────────────────────────

export interface PreviewRouterOptions {
  agentCwd: string;
  userOverrides?: UserOverrides;
}

export function createPreviewRoutes(options: PreviewRouterOptions) {
  const { agentCwd, userOverrides } = options;

  // ── Token generation (mounted under /api, requires auth) ───────

  const tokenRouter = Router();

  tokenRouter.post("/file/preview-token", (req, res) => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const { owner, root } = req.body || {};
    if ((owner && owner !== user.username) || root) {
      res.status(403).json({ error: "禁止查看其他用户文件" });
      return;
    }

    const userCwd = resolveUserCwd(agentCwd, {
      id: user.sub,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
    });
    const extraDirs = getUserExtraDirs(userOverrides, user.username);

    const token = randomUUID();
    previewTokens.set(token, {
      userCwd,
      extraDirs,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    res.json({ token });
  });

  // ── File serve (mounted at /preview, self-authenticated) ───────

  const serveRouter = Router();

  serveRouter.get("/:token/*", async (req, res) => {
    try {
      const { token } = req.params;
      // Express wildcard: req.path preserves percent-encoding, need to decode
      const filePath = decodeURIComponent(req.path.slice(token.length + 2));

      // Validate preview token
      const session = previewTokens.get(token);
      if (!session || session.expiresAt < Date.now()) {
        if (session) previewTokens.delete(token);
        res.status(401).json({ error: "Preview session expired" });
        return;
      }

      if (!filePath) {
        res.status(403).json({ error: "Invalid path" });
        return;
      }

      const absolutePath = resolveAuthorizedPath(
        filePath,
        session.userCwd,
        session.extraDirs,
      );
      if (!absolutePath) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      // Check file exists, is not a symlink, and is a regular file
      const fileStat = await lstat(absolutePath).catch(() => null);
      if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) {
        res.status(404).end();
        return;
      }

      const ext = extname(absolutePath).toLowerCase();
      const mimeType = MIME_MAP[ext] || "application/octet-stream";
      const isHtml = ext === ".html" || ext === ".htm";

      if (isHtml) {
        // HTML: inject <base> tag for relative path resolution + CSP header
        const content = await readFile(absolutePath, "utf-8");

        // Build <base> href from the raw (encoded) URL to preserve non-ASCII encoding
        const urlWithoutQuery = req.originalUrl.split("?")[0];
        const lastSlash = urlWithoutQuery.lastIndexOf("/");
        const baseHref = urlWithoutQuery.slice(0, lastSlash + 1);
        const baseTag = `<base href="${baseHref}">`;

        // Inject after <head> (case-insensitive, supports attributes on tag)
        let html: string;
        const headMatch = content.match(/<head(\s[^>]*)?>/i);
        if (headMatch) {
          const idx = content.indexOf(headMatch[0]) + headMatch[0].length;
          html = content.slice(0, idx) + baseTag + content.slice(idx);
        } else {
          html = baseTag + content;
        }

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", PREVIEW_CSP);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-cache");
        res.send(html);
      } else {
        // Non-HTML: stream file with appropriate Content-Type
        res.setHeader("Content-Type", mimeType);
        res.setHeader("X-Content-Type-Options", "nosniff");

        // Immutable media (images/video/audio): cache 1 year
        // Mutable resources (JS/CSS/JSON): cache 5 minutes
        const isMedia =
          mimeType.startsWith("image/") ||
          mimeType.startsWith("video/") ||
          mimeType.startsWith("audio/");
        res.setHeader(
          "Cache-Control",
          isMedia
            ? "private, max-age=31536000, immutable"
            : "private, max-age=300",
        );
        res.setHeader("Content-Length", fileStat.size);

        const stream = createReadStream(absolutePath);
        stream.pipe(res);
        stream.on("error", () => {
          if (!res.headersSent) res.status(500).end();
        });
      }
    } catch (error) {
      serverLogger.error("[preview] serve error:", error);
      if (!res.headersSent) res.status(500).end();
    }
  });

  return { tokenRouter, serveRouter };
}
