/**
 * 租户共享知识库（KB）文件只读服务（引用溯源卡，2026-07 唯恩批次）
 *
 * GET/HEAD /api/kb/file?path=<KB 内相对路径>
 *
 * - KB 根 = `<kbRootDir>/<req.user.tenantId>/`；tenantId 一律取自 JWT（不收参数），
 *   跨租户天然不可达。
 * - 挂载时外层套 tenantFeatureGuard(kbEnabled)（默认 false，租户显式开通才可用）。
 * - 四道路径安全：① path 拒绝 `/` 开头 ② resolve 后 isPathWithinDirectory
 *   ③ lstat 拒符号链接 ④ 扩展名白名单。
 * - MIME/inline/Range 语义与 file.ts /file/download 对齐（PDF 分片加载、图片内嵌）。
 * - 审计：仅记录带 Authorization header 的 GET（用户主动打开）；?token=（iframe/img
 *   自动加载）与 HEAD 预检不记。
 */

import { createReadStream } from "fs";
import { lstat } from "fs/promises";
import { basename, extname, resolve } from "path";
import { Router } from "express";
import { auditLog } from "../data/login-logs/index.js";
import { isPathWithinDirectory } from "../security/extraDirs.js";

/** KB 文件扩展名白名单（引用溯源支持的文档/图片/文本类型） */
const KB_ALLOWED_EXTS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".md",
  ".txt",
]);

const KB_MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export interface KbFilesRouterOptions {
  /** KB 存储根目录（各租户子目录的父目录），如 `<processCwd>/data/kb` */
  kbRootDir: string;
}

export function createKbFilesRouter(options: KbFilesRouterOptions): Router {
  const kbRootDir = resolve(options.kbRootDir);
  const router = Router();

  router.get("/file", async (req, res) => {
    try {
      const user = req.user;
      if (!user?.tenantId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const filePath = req.query.path as string | undefined;
      if (!filePath) {
        res.status(400).json({ error: "Missing path parameter" });
        return;
      }

      // ① 拒绝绝对路径（KB 内只接受相对路径）与内嵌 NUL
      if (filePath.startsWith("/") || filePath.includes("\0")) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      // ④ 扩展名白名单（先于文件系统访问，减小攻击面）
      const ext = extname(filePath).toLowerCase();
      if (!KB_ALLOWED_EXTS.has(ext)) {
        res.status(403).json({ error: "该文件类型不支持访问" });
        return;
      }

      // ② resolve 后必须仍在本租户 KB 根内（防 ../ 穿越）
      const tenantRoot = resolve(kbRootDir, user.tenantId);
      const absolutePath = resolve(tenantRoot, filePath);
      if (!isPathWithinDirectory(absolutePath, tenantRoot)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      // ③ 拒符号链接（file.ts 同款）
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        res
          .status(403)
          .json({ error: "Access denied: symbolic links not allowed" });
        return;
      }
      if (!stats.isFile()) {
        res.status(400).json({ error: "Not a file" });
        return;
      }

      const filename = basename(absolutePath);
      const contentType = KB_MIME_MAP[ext] || "application/octet-stream";
      // 图片/PDF inline 便于浏览器内嵌预览；md/txt 走 attachment 下载
      const disposition =
        contentType.startsWith("image/") || contentType === "application/pdf"
          ? "inline"
          : "attachment";

      // 审计：仅用户主动操作（Authorization header = authFetch），跳过 ?token= 自动加载与 HEAD
      if (req.method !== "HEAD" && req.headers.authorization) {
        auditLog(req, "kb_file_read", `${filePath} (${ext})`);
      }

      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Accept-Ranges", "bytes");

      if (req.method === "HEAD") {
        res.setHeader("Content-Type", contentType);
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${encodeURIComponent(filename)}"`,
        );
        res.setHeader("Content-Length", stats.size);
        res.end();
        return;
      }

      // Range 请求支持（浏览器原生 PDF viewer 按页分片加载）
      // RFC 7233 语义（2026-07 审查 F4）：suffix（bytes=-N）取末 N 字节回 206；
      // 无法解析（NaN/负数/start>end）忽略 Range 回 200 全量；end 越界 clamp 回 206；
      // start ≥ size → 416（带 Content-Range: bytes */size）
      const range = req.headers.range;
      const parsedRange = range ? parseByteRange(range, stats.size) : null;
      if (parsedRange?.kind === "unsatisfiable") {
        res
          .status(416)
          .setHeader("Content-Range", `bytes */${stats.size}`)
          .end();
        return;
      }
      if (parsedRange?.kind === "range") {
        const { start, end } = parsedRange;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          "Content-Length": end - start + 1,
          "Content-Type": contentType,
          "Content-Disposition": `${disposition}; filename="${encodeURIComponent(filename)}"`,
        });
        const stream = createReadStream(absolutePath, { start, end });
        stream.pipe(res);
        stream.on("error", () => {
          if (!res.headersSent) res.status(500).end();
        });
        return;
      }

      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${encodeURIComponent(filename)}"`,
      );
      res.setHeader("Content-Length", stats.size);

      const stream = createReadStream(absolutePath);
      stream.pipe(res);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        }
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
      } else {
        res.status(500).json({ error: "Failed to read file" });
      }
    }
  });

  return router;
}

type ParsedByteRange =
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" }
  | null;

/**
 * 解析单段 Range 头（RFC 7233）。
 * - `bytes=A-B` / `bytes=A-`：end 越界 clamp 到 size-1；start ≥ size → unsatisfiable（416）
 * - `bytes=-N`：suffix 范围，取文件末 N 字节；N=0 或空文件 → unsatisfiable（416）
 * - 语法无法解析（NaN/负数/start>end/多段）→ null（忽略 Range 回 200 全量）
 */
function parseByteRange(header: string, size: number): ParsedByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = parseInt(match[2], 10);
    if (suffix <= 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = parseInt(match[1], 10);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
  // last-byte-pos < first-byte-pos：语法无效，整个 Range 头忽略（RFC 7233 §2.1）
  if (start > end) return null;
  return { kind: "range", start, end };
}
