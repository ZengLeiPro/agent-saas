import { basename, extname, join, relative } from 'path';
import multer from 'multer';
import { Router } from 'express';
import type { UploadedFileInfo } from '../types/index.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { ensureWorkspaceRuntimeLayout, repairWorkspacePath } from '../workspace/permissions.js';
import { uploadLogger } from '../utils/logger.js';

/**
 * 修复 multer 中文文件名编码问题（浏览器发送 UTF-8，multer 默认用 latin1 解析）
 */
function fixFilename(filename: string): string {
  try {
    return Buffer.from(filename, 'latin1').toString('utf8');
  } catch {
    return filename;
  }
}

export interface UploadRouterOptions {
  /** Agent 工作目录（绝对路径） */
  agentCwd: string;
}

/**
 * 创建文件上传路由
 * @param options 路由配置选项
 * @returns Express Router
 */
export function createUploadRouter(options: UploadRouterOptions): Router {
  const { agentCwd } = options;
  const router = Router();

  // Per-request 动态解析 upload 目录
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const user = (req as any).user;
      const userCwd = resolveUserCwd(agentCwd, user
        ? { id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId } : undefined);
      ensureWorkspaceRuntimeLayout(userCwd);
      const userUploadsDir = join(userCwd, 'uploads');
      cb(null, userUploadsDir);
    },
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const fixedName = fixFilename(file.originalname);
      const ext = extname(fixedName);
      const baseName = basename(fixedName, ext)
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
        .substring(0, 100);
      cb(null, `${timestamp}_${baseName}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 1024 * 1024 * 1024,
      files: 10,
    },
  });

  router.post('/upload', upload.array('files', 10), (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({ success: false, error: 'No files uploaded' });
        return;
      }

      // 基于 per-user cwd 计算 relativePath
      const user = (req as any).user;
      const userCwd = resolveUserCwd(agentCwd, user
        ? { id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId } : undefined);

      const uploadedFiles: UploadedFileInfo[] = files.map((file) => {
        repairWorkspacePath(file.path, 0o664);
        const isImage = file.mimetype.startsWith('image/');
        const supportedImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

        return {
          originalName: fixFilename(file.originalname),
          savedPath: file.path,
          relativePath: relative(userCwd, file.path),
          size: file.size,
          mimeType: file.mimetype,
          isImage: isImage && supportedImageTypes.includes(file.mimetype),
        };
      });

      uploadLogger.info(
        `${uploadedFiles.length} file(s) uploaded: ${uploadedFiles.map((f) => f.originalName).join(', ')}`,
      );

      res.json({ success: true, files: uploadedFiles });
    } catch (error) {
      uploadLogger.error('Error:', error);
      res.status(500).json({ success: false, error: 'Upload failed' });
    }
  });

  return router;
}
