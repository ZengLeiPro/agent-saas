import { readFile, readdir, lstat, unlink, rm } from "fs/promises";
import { createReadStream } from "fs";
import { resolve, extname, basename, dirname, join } from "path";
import { Router } from "express";
import { resolveUserCwd } from "../workspace/resolver.js";
import { serverLogger } from "../utils/logger.js";
import { auditLog } from "../data/login-logs/index.js";
import {
  getUserExtraDirs,
  resolveAuthorizedPath,
  type UserOverrides,
} from "../security/extraDirs.js";

/** /api/file/read 允许预览读取的扩展名（文本/代码/标记类，须 ⊇ 前端可预览集合） */
const PREVIEW_READ_EXTS = new Set([
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".txt",
  ".log",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".sh",
  ".bash",
  ".zsh",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".css",
  ".scss",
  ".less",
  ".sql",
  ".env",
  ".conf",
]);

/** 预览读取的体积上限：超过则拒绝并引导走下载（避免大文件爆内存/卡死前端） */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  extension: string;
}

interface FileListResponse {
  entries: FileEntry[];
  currentPath: string;
  parentPath: string | null;
}

export interface FileRouterOptions {
  agentCwd: string;
  userOverrides?: UserOverrides;
}

export function createFileRouter(options: FileRouterOptions): Router {
  const { agentCwd, userOverrides } = options;
  const router = Router();

  function resolveFileRoutePath(
    filePath: string,
    userCwd: string,
    effectiveUsername: string | undefined,
  ): string {
    return (
      resolveAuthorizedPath(
        filePath,
        userCwd,
        getUserExtraDirs(userOverrides, effectiveUsername),
      ) ?? ""
    );
  }

  function rejectCrossUserParams(req: any, res: any): boolean {
    const ownerParam = req.query.owner as string | undefined;
    if (ownerParam && ownerParam !== req.user?.username) {
      res.status(403).json({ error: "禁止查看其他用户文件" });
      return true;
    }
    if (req.query.root === "true") {
      res.status(403).json({ error: "禁止查看其他用户文件" });
      return true;
    }
    return false;
  }

  router.get("/file/read", async (req, res) => {
    const filePath = req.query.path as string | undefined;
    const user = (req as any).user;
    let userCwd = "";
    let absolutePath = "";
    try {
      if (!filePath) {
        res.status(400).json({ error: "Missing path parameter" });
        return;
      }

      // 允许预览的文本/代码/标记类扩展名（其余类型走 /file/download）
      if (!PREVIEW_READ_EXTS.has(extname(filePath).toLowerCase())) {
        res.status(403).json({ error: "该文件类型不支持预览" });
        return;
      }

      if (rejectCrossUserParams(req as any, res)) return;

      userCwd = resolveUserCwd(
        agentCwd,
        user
          ? {
              id: user.sub,
              username: user.username,
              role: user.role,
              tenantId: user.tenantId,
            }
          : undefined,
      );
      absolutePath = resolveFileRoutePath(filePath, userCwd, user?.username);
      if (!absolutePath) {
        serverLogger.warn(
          `[file/read] BLOCKED user=${user?.username} path=${filePath} resolved=${absolutePath} cwd=${userCwd}`,
        );
        res.status(403).json({
          error: "Access denied: path outside authorized directories",
        });
        return;
      }

      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        res
          .status(403)
          .json({ error: "Access denied: symbolic links not allowed" });
        return;
      }
      if (!fileStat.isFile()) {
        res.status(400).json({ error: "Not a file" });
        return;
      }
      if (fileStat.size > MAX_PREVIEW_BYTES) {
        res.status(413).json({ error: "文件过大，无法预览，请下载查看" });
        return;
      }

      const content = await readFile(absolutePath, "utf-8");
      const filename = absolutePath.split("/").pop() || filePath;

      auditLog(req as any, "file_previewed", filePath);
      res.json({ content, filename });
    } catch (error: any) {
      if (error.code === "ENOENT") {
        serverLogger.warn(
          `[file/read] NOT_FOUND user=${user?.username} path=${filePath} resolved=${absolutePath} cwd=${userCwd}`,
        );
        res.status(404).json({ error: "File not found" });
      } else {
        res.status(500).json({ error: "Failed to read file" });
      }
    }
  });

  router.get("/file/download", async (req, res) => {
    try {
      const filePath = req.query.path as string | undefined;
      if (!filePath) {
        res.status(400).json({ error: "Missing path parameter" });
        return;
      }

      const user = (req as any).user;
      if (rejectCrossUserParams(req as any, res)) return;

      let absolutePath: string;
      let userCwd: string | undefined;
      const effectiveUsername = user?.username;
      userCwd = resolveUserCwd(
        agentCwd,
        user
          ? {
              id: user.sub,
              username: user.username,
              role: user.role,
              tenantId: user.tenantId,
            }
          : undefined,
      );
      absolutePath = resolveFileRoutePath(filePath, userCwd, effectiveUsername);
      if (!absolutePath) {
        res.status(403).json({
          error: "Access denied: path outside authorized directories",
        });
        return;
      }
      // 拒绝符号链接 + referrer 兜底（md 预览相对路径支持）
      // 当按工作区根解析后 ENOENT 且 query 带 referrer（md 文件路径）时，
      // 使用 dirname(referrer) 作为 base 重新解析一次。
      // 兜底必须复用 resolveFileRoutePath，保留普通用户的 resolveAuthorizedPath 边界检查。
      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch (e: any) {
        const referrerRaw = req.query.referrer as string | undefined;
        if (e?.code === "ENOENT" && referrerRaw && userCwd) {
          let decodedReferrer = referrerRaw;
          try {
            const d = decodeURIComponent(referrerRaw);
            if (d !== referrerRaw) decodedReferrer = d;
          } catch {
            /* 保持原样 */
          }
          const referrerDir = dirname(decodedReferrer);
          const fallbackInput = join(referrerDir, filePath);
          const fallbackAbs = resolveFileRoutePath(
            fallbackInput,
            userCwd,
            effectiveUsername,
          );
          if (!fallbackAbs) throw e; // 越界 → 维持 404
          try {
            stats = await lstat(fallbackAbs);
            absolutePath = fallbackAbs;
          } catch {
            throw e; // 兜底也 ENOENT → 维持 404
          }
        } else {
          throw e;
        }
      }
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
      const ext = extname(filename).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".pdf": "application/pdf",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls": "application/vnd.ms-excel",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".csv": "text/csv",
        ".txt": "text/plain",
        ".json": "application/json",
        ".md": "text/markdown",
        ".html": "text/html",
        ".htm": "text/html",
        ".zip": "application/zip",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
      };
      const contentType = mimeMap[ext] || "application/octet-stream";

      // image/video/pdf 用 inline，便于浏览器内嵌预览（<img>/<video>/iframe）；其余走 attachment 下载
      const disposition =
        contentType.startsWith("image/") ||
        contentType.startsWith("video/") ||
        contentType === "application/pdf"
          ? "inline"
          : "attachment";

      // 审计：仅记录用户主动操作（Authorization header = authFetch），跳过自动加载（?token= = img/video src）和 HEAD 请求
      if (req.method !== "HEAD" && req.headers.authorization) {
        auditLog(req as any, "file_downloaded", `${filename} (${ext})`);
      }

      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Accept-Ranges", "bytes");

      // Range 请求支持（视频 seek 等）
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;

        if (start >= stats.size || end >= stats.size || start > end) {
          res
            .status(416)
            .setHeader("Content-Range", `bytes */${stats.size}`)
            .end();
          return;
        }

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
    } catch (error: any) {
      if (error.code === "ENOENT") {
        const u = (req as any).user;
        const p = req.query.path as string;
        serverLogger.warn(
          `[file/download] NOT_FOUND user=${u?.username} path=${p}`,
        );
        res.status(404).json({ error: "File not found" });
      } else {
        res.status(500).json({ error: "Failed to download file" });
      }
    }
  });

  router.get("/file/list", async (req, res) => {
    const user = (req as any).user;
    try {
      const requestedPath = (req.query.path as string) || "assets";
      // 拒绝包含 .. 或以 / 开头的路径
      if (requestedPath.includes("..") || requestedPath.startsWith("/")) {
        res
          .status(403)
          .json({ error: "Access denied: path traversal not allowed" });
        return;
      }

      if (rejectCrossUserParams(req as any, res)) return;

      // 解析当前用户工作区
      const userCwd = resolveUserCwd(
        agentCwd,
        user
          ? {
              id: user.sub,
              username: user.username,
              role: user.role,
              tenantId: user.tenantId,
            }
          : undefined,
      );

      const absolutePath = resolve(userCwd, requestedPath);

      // 安全校验：必须在 {userCwd}/assets 或 {userCwd}/memory 之下
      const assetsRoot = join(userCwd, "assets");
      const memoryRoot = join(userCwd, "memory");
      const inAssets =
        absolutePath.startsWith(assetsRoot + "/") ||
        absolutePath === assetsRoot;
      const inMemory =
        absolutePath.startsWith(memoryRoot + "/") ||
        absolutePath === memoryRoot;
      if (!inAssets && !inMemory) {
        res
          .status(403)
          .json({ error: "Access denied: path outside allowed directories" });
        return;
      }

      // 检查目录是否存在
      let dirStat;
      try {
        dirStat = await lstat(absolutePath);
      } catch (e: any) {
        if (e.code === "ENOENT") {
          // 目录不存在，返回空列表
          const response: FileListResponse = {
            entries: [],
            currentPath: requestedPath,
            parentPath:
              requestedPath === "assets" ? null : dirname(requestedPath),
          };
          res.json(response);
          return;
        }
        throw e;
      }

      if (dirStat.isSymbolicLink()) {
        res
          .status(403)
          .json({ error: "Access denied: symbolic links not allowed" });
        return;
      }
      if (!dirStat.isDirectory()) {
        res.status(400).json({ error: "Not a directory" });
        return;
      }

      const recursive = req.query.recursive === "true";

      // 递归扫描辅助函数
      async function scanDir(
        dirAbsPath: string,
        dirRelPath: string,
        result: FileEntry[],
      ): Promise<void> {
        const names = await readdir(dirAbsPath);
        await Promise.all(
          names.map(async (name) => {
            if (name.startsWith(".")) return;
            try {
              const entryAbsPath = join(dirAbsPath, name);
              const entryStat = await lstat(entryAbsPath);
              if (entryStat.isSymbolicLink()) return;
              const isDir = entryStat.isDirectory();
              const entryRelPath = join(dirRelPath, name);
              if (recursive && isDir) {
                // 递归模式：只收集文件，跳过目录条目
                await scanDir(entryAbsPath, entryRelPath, result);
              } else {
                result.push({
                  name,
                  path: entryRelPath,
                  isDirectory: isDir,
                  size: isDir ? 0 : entryStat.size,
                  modifiedAt: entryStat.mtimeMs,
                  extension: isDir ? "" : extname(name).toLowerCase(),
                });
              }
            } catch {
              // 无法 stat 的条目跳过
            }
          }),
        );
      }

      const entries: FileEntry[] = [];
      await scanDir(absolutePath, requestedPath, entries);

      // 排序：目录在前（字母序），文件在后（字母序）
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const response: FileListResponse = {
        entries,
        currentPath: requestedPath,
        parentPath: requestedPath === "assets" ? null : dirname(requestedPath),
      };
      res.json(response);
    } catch (error) {
      serverLogger.error(`[file/list] ERROR user=${user?.username}`, error);
      res.status(500).json({ error: "Failed to list directory" });
    }
  });

  router.delete("/file/delete", async (req, res) => {
    const user = (req as any).user;
    try {
      const filePath = req.query.path as string | undefined;
      if (!filePath) {
        res.status(400).json({ error: "Missing path parameter" });
        return;
      }

      if (filePath.includes("..")) {
        res
          .status(403)
          .json({ error: "Access denied: path traversal not allowed" });
        return;
      }

      if (rejectCrossUserParams(req as any, res)) return;

      // 解析当前用户工作区
      const userCwd = resolveUserCwd(
        agentCwd,
        user
          ? {
              id: user.sub,
              username: user.username,
              role: user.role,
              tenantId: user.tenantId,
            }
          : undefined,
      );

      const absolutePath = resolve(userCwd, filePath);

      // 安全校验：必须在 {userCwd}/assets 之下
      const assetsRoot = join(userCwd, "assets");
      if (
        !absolutePath.startsWith(assetsRoot + "/") &&
        absolutePath !== assetsRoot
      ) {
        res
          .status(403)
          .json({ error: "Access denied: path outside assets directory" });
        return;
      }

      // 禁止删除 assets 根目录本身
      if (absolutePath === assetsRoot) {
        res.status(403).json({ error: "Cannot delete assets root directory" });
        return;
      }

      // 检查文件/目录是否存在
      const targetStat = await lstat(absolutePath).catch((e: any) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });

      if (!targetStat) {
        res.status(404).json({ error: "File or directory not found" });
        return;
      }

      if (targetStat.isSymbolicLink()) {
        res
          .status(403)
          .json({ error: "Access denied: symbolic links not allowed" });
        return;
      }

      if (targetStat.isDirectory()) {
        await rm(absolutePath, { recursive: true, force: true });
        serverLogger.info(
          `[file/delete] DIR user=${user?.username} path=${filePath}`,
        );
      } else {
        await unlink(absolutePath);
        serverLogger.info(
          `[file/delete] FILE user=${user?.username} path=${filePath}`,
        );
      }

      auditLog(req as any, "file_deleted", filePath);
      res.json({ success: true });
    } catch (error) {
      serverLogger.error(`[file/delete] ERROR user=${user?.username}`, error);
      res.status(500).json({ error: "Failed to delete" });
    }
  });

  return router;
}
