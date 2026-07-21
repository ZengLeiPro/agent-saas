import { randomUUID } from 'crypto';
import { basename, extname } from 'path';
import multer from 'multer';
import { Router, type Request } from 'express';
import { resolveUserCwd } from '../workspace/resolver.js';
import { ensureWorkspaceRuntimeLayout } from '../workspace/permissions.js';
import { uploadLogger } from '../utils/logger.js';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES_PER_REQUEST,
  UploadDrainingError,
  type UploadManager,
} from '../uploads/manager.js';

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
  uploadManager: UploadManager;
}

interface UploadRequest extends Request {
  uploadPartialDir?: string;
}

function resolveRequestUserCwd(agentCwd: string, req: Request): string {
  const user = req.user;
  return resolveUserCwd(agentCwd, user
    ? { id: user.sub, username: user.username, role: user.role, tenantId: user.tenantId }
    : undefined);
}

function uploadErrorResponse(error: unknown): { status: number; message: string; code?: string } {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, message: '单文件不能超过 2 GiB', code: error.code };
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return { status: 413, message: '单次最多上传 20 个文件', code: error.code };
    }
  }
  return { status: 500, message: 'Upload failed' };
}

/**
 * 创建文件上传路由
 * @param options 路由配置选项
 * @returns Express Router
 */
export function createUploadRouter(options: UploadRouterOptions): Router {
  const { agentCwd, uploadManager } = options;
  const router = Router();

  // Per-request 动态解析 upload 目录
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const partialDir = (req as UploadRequest).uploadPartialDir;
      if (!partialDir) {
        cb(new Error('Upload request was not prepared'), '');
        return;
      }
      cb(null, partialDir);
    },
    filename: (_req, file, cb) => {
      const fixedName = fixFilename(file.originalname);
      const ext = extname(fixedName);
      const baseName = basename(fixedName, ext)
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
        .substring(0, 100);
      cb(null, `${randomUUID()}_${baseName || 'file'}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_UPLOAD_FILE_BYTES,
      files: MAX_UPLOAD_FILES_PER_REQUEST,
    },
  });

  router.post('/upload', async (req, res) => {
    const uploadReq = req as UploadRequest;
    const requestId = randomUUID();
    let completionStarted = false;

    try {
      const userCwd = resolveRequestUserCwd(agentCwd, req);
      ensureWorkspaceRuntimeLayout(userCwd);
      uploadReq.uploadPartialDir = await uploadManager.beginRequest(userCwd, requestId);
      // 允许 20 × 2 GiB 的合法请求持续传输；nginx 仍负责连接空闲超时。
      req.setTimeout(12 * 60 * 60 * 1000);
    } catch (error) {
      if (error instanceof UploadDrainingError) {
        res.setHeader('Retry-After', '10');
        res.status(503).json({ success: false, error: '服务正在更新，请稍后重试', code: 'SERVER_DRAINING' });
        return;
      }
      uploadLogger.error('Failed to prepare upload:', error);
      res.status(500).json({ success: false, error: 'Upload failed' });
      return;
    }

    req.once('aborted', () => {
      if (completionStarted) return;
      void uploadManager.finishFailedRequest(requestId, 'aborted');
    });

    upload.array('files', MAX_UPLOAD_FILES_PER_REQUEST)(req, res, async (uploadError) => {
      completionStarted = true;
      if (uploadError) {
        await uploadManager.finishFailedRequest(requestId, req.aborted ? 'aborted' : 'failed');
        const response = uploadErrorResponse(uploadError);
        uploadLogger.warn(`Upload rejected request=${requestId} code=${response.code ?? 'unknown'} error=${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
        if (!res.headersSent && !res.writableEnded) {
          res.status(response.status).json({ success: false, error: response.message, ...(response.code ? { code: response.code } : {}) });
        }
        return;
      }

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        await uploadManager.finishFailedRequest(requestId, 'failed');
        res.status(400).json({ success: false, error: 'No files uploaded' });
        return;
      }

      try {
        const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
        const finalized = await uploadManager.completeRequest(requestId, files.map((file) => {
          const fixedOriginalName = fixFilename(file.originalname);
          const attachmentId = file.filename.slice(0, file.filename.indexOf('_'));
          return {
            attachmentId,
            filename: file.filename,
            partialPath: file.path,
            originalName: fixedOriginalName,
            size: file.size,
            mimeType: file.mimetype,
            isImage: file.mimetype.startsWith('image/') && supportedImageTypes.has(file.mimetype),
            isVoiceUpload: file.mimetype.startsWith('audio/') || /\.(wav|mp3|m4a|amr|ogg)$/i.test(fixedOriginalName),
          };
        }));
        const uploadedFiles = finalized.map((file) => file.info);
        uploadLogger.info(`Upload complete request=${requestId} files=${uploadedFiles.length} bytes=${uploadedFiles.reduce((sum, file) => sum + file.size, 0)} names=${uploadedFiles.map((file) => file.originalName).join(', ')}`);
        if (!res.writableEnded) res.json({ success: true, files: uploadedFiles });
      } catch (error) {
        uploadLogger.error(`Upload finalize failed request=${requestId}:`, error);
        if (!res.headersSent && !res.writableEnded) {
          res.status(500).json({ success: false, error: 'Upload failed' });
        }
      }
    });
  });

  router.get('/uploads/usage', async (req, res) => {
    try {
      const userCwd = resolveRequestUserCwd(agentCwd, req);
      ensureWorkspaceRuntimeLayout(userCwd);
      res.json({ success: true, usage: await uploadManager.getUsage(userCwd) });
    } catch (error) {
      uploadLogger.error('Failed to inspect attachment usage:', error);
      res.status(500).json({ success: false, error: '读取附件用量失败' });
    }
  });

  router.delete('/uploads/staged', async (req, res) => {
    try {
      const userCwd = resolveRequestUserCwd(agentCwd, req);
      const result = await uploadManager.cleanupUserStaged(userCwd);
      uploadLogger.info(`Manual staged cleanup user=${req.user?.username ?? 'anonymous'} files=${result.deletedFiles} bytes=${result.deletedBytes}`);
      res.json({ success: true, ...result });
    } catch (error) {
      uploadLogger.error('Failed to clean staged attachments:', error);
      res.status(500).json({ success: false, error: '清理未发送附件失败' });
    }
  });

  return router;
}
