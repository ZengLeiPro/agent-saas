/**
 * Voice 路由
 *
 * 提供语音文件回放端点，支持 Range 请求用于音频 seeking。
 */

import { resolve, relative } from "path";
import { Router } from "express";
import { resolveUserCwd } from "../workspace/resolver.js";
import { UnsafeFilePathError, openTrustedFile } from "../security/trustedFile.js";

export interface VoiceRouterOptions {
  agentCwd: string;
}

export function createVoiceRouter(options: VoiceRouterOptions): Router {
  const { agentCwd } = options;
  const router = Router();

  /**
   * GET /voice/play?path=uploads/voice_xxx.wav
   *
   * 安全校验 + 流式返回音频文件，支持 Range 请求
   */
  router.get("/voice/play", async (req, res) => {
    try {
      const filePath = req.query.path as string | undefined;
      if (!filePath) {
        res.status(400).json({ error: "Missing path parameter" });
        return;
      }

      // 拒绝包含 .. 的路径
      if (filePath.includes("..")) {
        res
          .status(403)
          .json({ error: "Access denied: path traversal not allowed" });
        return;
      }

      const user = (req as any).user;

      const ownerParam = req.query.owner as string | undefined;
      if (ownerParam && ownerParam !== user?.username) {
        res.status(403).json({ error: "禁止查看其他用户文件" });
        return;
      }

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

      if (!absolutePath.startsWith(userCwd + "/") && absolutePath !== userCwd) {
        res
          .status(403)
          .json({ error: "Access denied: path outside workspace" });
        return;
      }

      let opened;
      try {
        opened = await openTrustedFile(userCwd, relative(userCwd, absolutePath));
      } catch (error) {
        if (error instanceof UnsafeFilePathError) {
          res.status(403).json({ error: "Access denied: symbolic links not allowed" });
        } else {
          res.status(404).json({ error: "File not found" });
        }
        return;
      }

      const fileSize = opened.stats.size;

      // 根据扩展名推断 MIME 类型
      const mimeMap: Record<string, string> = {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".webm": "audio/webm",
      };
      const ext = absolutePath
        .substring(absolutePath.lastIndexOf("."))
        .toLowerCase();
      const contentType = mimeMap[ext] || "application/octet-stream";

      // 处理 Range 请求
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
          await opened.handle.close();
          res
            .status(416)
            .setHeader("Content-Range", `bytes */${fileSize}`)
            .end();
          return;
        }

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", end - start + 1);
        res.setHeader("Content-Type", contentType);

        opened.handle.createReadStream({ start, end, autoClose: true }).pipe(res);
      } else {
        res.setHeader("Content-Length", fileSize);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Accept-Ranges", "bytes");

        opened.handle.createReadStream({ autoClose: true }).pipe(res);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to stream audio file" });
    }
  });

  return router;
}
