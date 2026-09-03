import { randomUUID } from 'crypto';
import { createReadStream } from 'node:fs';
import { basename, extname, join } from 'path';
import multer from 'multer';
import { Router, type Request } from 'express';
import { resolveUserCwd } from '../workspace/resolver.js';
import { ensureWorkspaceRuntimeLayout } from '../workspace/permissions.js';
import { uploadLogger } from '../utils/logger.js';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES_PER_REQUEST,
  AttachmentUnavailableError,
  UploadDrainingError,
  type UploadManager,
} from '../uploads/manager.js';
import { attachmentResponseHeaders, inspectUploadedFile, UploadPolicyError } from '../uploads/uploadSecurity.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import { INCOMING_SHARE_MAX_ITEMS, INCOMING_SHARE_MAX_TOTAL_BYTES, incomingShareKind } from '../../../shared/src/lib/incomingShare.js';

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

function safeUploadFilename(originalName: string): string {
  const ext = extname(originalName);
  const baseName = basename(originalName, ext)
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
    .substring(0, 100);
  return `${randomUUID()}_${baseName || 'file'}${ext}`;
}


const UPLOAD_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INLINE_AUDIO_MIME_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg']);

type ByteRange = { start: number; end: number };
function parseAttachmentRange(raw: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!raw) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return 'invalid';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || requestedEnd < start || start >= size) return 'invalid';
  return { start, end: Math.min(size - 1, requestedEnd) };
}

function uploadRequestId(req: Request): string {
  const supplied = typeof req.headers['x-upload-request-id'] === 'string'
    ? req.headers['x-upload-request-id'].trim()
    : '';
  if (!supplied) return randomUUID();
  if (!UPLOAD_REQUEST_ID_RE.test(supplied)) {
    throw Object.assign(new Error('Invalid upload request id'), { statusCode: 400, code: 'UPLOAD_REQUEST_ID_INVALID' });
  }
  return supplied;
}

export interface UploadRouterOptions {
  /** Agent 工作目录（绝对路径） */
  agentCwd: string;
  uploadManager: UploadManager;
  sessionCatalog?: Pick<SessionCatalog, 'get'>;
}

interface UploadRequest extends Request {
  uploadPartialDir?: string;
}

function isIncomingShare(req: Request): boolean {
  return req.headers['x-upload-source'] === 'incoming-share';
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
  const { agentCwd, uploadManager, sessionCatalog } = options;
  const router = Router();

  async function assertSessionOwnership(req: Request): Promise<string | undefined> {
    const rawSessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!rawSessionId) return undefined;
    const user = req.user;
    const session = await sessionCatalog?.get(rawSessionId);
    if (!user || !session || session.userId !== user.sub
      || (session.tenantId && user.tenantId && session.tenantId !== user.tenantId)) {
      throw Object.assign(new Error('Upload session is not owned by the current user'), { statusCode: 403 });
    }
    return rawSessionId;
  }

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
      cb(null, safeUploadFilename(fixFilename(file.originalname)));
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: MAX_UPLOAD_FILE_BYTES,
      files: MAX_UPLOAD_FILES_PER_REQUEST,
    },
  });

  const incomingShareUpload = multer({
    storage,
    limits: {
      fileSize: INCOMING_SHARE_MAX_TOTAL_BYTES,
      files: INCOMING_SHARE_MAX_ITEMS,
    },
  });

  router.post('/upload/assets', async (req, res) => {
    const requestId = randomUUID();
    try {
      const sessionId = await assertSessionOwnership(req);
      const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
      if (paths.length === 0 || paths.length > MAX_UPLOAD_FILES_PER_REQUEST
        || paths.some((path: unknown) => typeof path !== 'string')) {
        res.status(400).json({ success: false, error: `请选择 1-${MAX_UPLOAD_FILES_PER_REQUEST} 个资料库文件` });
        return;
      }

      const uniquePaths = [...new Set(paths as string[])];
      if (uniquePaths.length !== paths.length) {
        res.status(400).json({ success: false, error: '不能重复选择同一个文件' });
        return;
      }

      const userCwd = resolveRequestUserCwd(agentCwd, req);
      ensureWorkspaceRuntimeLayout(userCwd);
      const files = await uploadManager.registerAssetReferences(
        userCwd,
        uniquePaths,
        sessionId ? { sessionId } : {},
      );
      res.json({ success: true, files });
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error
        ? Number(error.statusCode)
        : error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
          ? 400
          : 500;
      uploadLogger.warn(`Asset reference failed request=${requestId}: ${error instanceof Error ? error.message : String(error)}`);
      res.status(status).json({
        success: false,
        error: status === 413
          ? '单文件不能超过 2 GiB'
          : status === 403
            ? '上传会话不属于当前用户'
            : status === 400
              ? '所选资料库文件无效或已不存在'
              : '添加资料失败',
      });
    }
  });

  router.post('/upload', async (req, res) => {
    const uploadReq = req as UploadRequest;
    let requestId = '';
    let completionStarted = false;
    let sessionId: string | undefined;

    try {
      requestId = uploadRequestId(req);
      sessionId = await assertSessionOwnership(req);
      const userCwd = resolveRequestUserCwd(agentCwd, req);
      ensureWorkspaceRuntimeLayout(userCwd);
      const replay = await uploadManager.getCompletedRequest(userCwd, requestId, sessionId);
      if (replay) {
        res.setHeader('X-Upload-Request-Id', requestId);
        res.json({ success: true, requestId, idempotentReplay: true, files: replay });
        return;
      }
      uploadReq.uploadPartialDir = await uploadManager.beginRequest(userCwd, requestId);
      // 允许 20 × 2 GiB 的合法请求持续传输；nginx 仍负责连接空闲超时。
      req.setTimeout(12 * 60 * 60 * 1000);
    } catch (error) {
      const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
      if (statusCode === 400) {
        res.status(400).json({ success: false, error: 'uploadRequestId 格式无效', code: 'UPLOAD_REQUEST_ID_INVALID' });
        return;
      }
      if (statusCode === 409 || (error instanceof Error && error.message.startsWith('Duplicate upload request'))) {
        res.status(409).json({ success: false, error: '相同 uploadRequestId 正在处理中', code: 'UPLOAD_REQUEST_IN_PROGRESS' });
        return;
      }
      if (error instanceof UploadDrainingError) {
        res.setHeader('Retry-After', '10');
        res.status(503).json({ success: false, error: '服务正在更新，请稍后重试', code: 'SERVER_DRAINING' });
        return;
      }
      if (statusCode === 403) {
        res.status(403).json({ success: false, error: '上传会话不属于当前用户', code: 'UPLOAD_SESSION_FORBIDDEN' });
        return;
      }
      uploadLogger.error('Failed to prepare upload:', error);
      res.status(500).json({ success: false, error: 'Upload failed', code: 'UPLOAD_PREPARE_FAILED' });
      return;
    }

    req.once('aborted', () => {
      if (completionStarted) return;
      void uploadManager.finishFailedRequest(requestId, 'aborted');
    });
    req.once('close', () => {
      if (completionStarted || res.writableEnded) return;
      const timer = setTimeout(() => {
        if (completionStarted || res.writableEnded) return;
        uploadLogger.warn(`Upload connection closed before completion request=${requestId}; releasing drain counter`);
        void uploadManager.finishFailedRequest(requestId, 'aborted');
      }, 5_000);
      timer.unref?.();
    });

    const uploadMiddleware = isIncomingShare(req)
      ? incomingShareUpload.array('files', INCOMING_SHARE_MAX_ITEMS)
      : upload.array('files', MAX_UPLOAD_FILES_PER_REQUEST);
    uploadMiddleware(req, res, async (uploadError) => {
      completionStarted = true;
      if (uploadError) {
        await uploadManager.finishFailedRequest(requestId, req.aborted ? 'aborted' : 'failed');
        const response = isIncomingShare(req) && uploadError instanceof multer.MulterError
          ? { status: 413, message: '系统分享最多 5 项且总大小不能超过 20 MB', code: 'UPLOAD_SHARE_LIMIT' }
          : uploadErrorResponse(uploadError);
        uploadLogger.warn(`Upload rejected request=${requestId} code=${response.code ?? 'unknown'}`);
        if (!res.headersSent && !res.writableEnded) {
          res.status(response.status).json({ success: false, error: response.message, ...(response.code ? { code: response.code } : {}) });
        }
        return;
      }

      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        await uploadManager.finishFailedRequest(requestId, 'failed');
        res.status(400).json({ success: false, error: 'No files uploaded', code: 'UPLOAD_EMPTY' });
        return;
      }

      try {
        if (isIncomingShare(req)) {
          const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
          if (files.length > INCOMING_SHARE_MAX_ITEMS || totalBytes > INCOMING_SHARE_MAX_TOTAL_BYTES) {
            throw new UploadPolicyError('UPLOAD_SIZE_EXCEEDED', '系统分享最多 5 项且总大小不能超过 20 MB', 413);
          }
          for (const file of files) {
            const kind = incomingShareKind(file.mimetype || 'application/octet-stream');
            if (kind !== 'image' && kind !== 'pdf') {
              throw new UploadPolicyError('UPLOAD_MIME_BLOCKED', '系统分享仅支持图片与 PDF 文件', 422);
            }
          }
        }
        const inspected = await Promise.all(files.map(async (file) => {
          const originalName = fixFilename(file.originalname);
          return {
            file,
            originalName,
            security: await inspectUploadedFile({ path: file.path, originalName, size: file.size, mimetype: file.mimetype }),
          };
        }));
        if (isIncomingShare(req)) {
          for (const { file, originalName, security } of inspected) {
            const kind = incomingShareKind(file.mimetype || 'application/octet-stream');
            const detectedKind = security.detectedMimeType === 'application/pdf'
              ? 'pdf'
              : security.isImage ? 'image' : 'unsupported';
            if (security.contentMismatch || kind !== detectedKind) {
              throw new UploadPolicyError('UPLOAD_MIME_MISMATCH', `文件真实类型与声明不一致：${originalName}`);
            }
            if (security.activeContent) {
              throw new UploadPolicyError('UPLOAD_EXECUTABLE_CONTENT', `文件包含系统分享不支持的主动内容：${originalName}`);
            }
          }
        }
        const finalized = await uploadManager.completeRequest(requestId, inspected.map(({ file, originalName, security }) => ({
          attachmentId: file.filename.slice(0, file.filename.indexOf('_')),
          filename: file.filename,
          partialPath: file.path,
          originalName,
          size: file.size,
          mimeType: security.mimeType,
          isImage: security.isImage,
          isVoiceUpload: security.mimeType.startsWith('audio/'),
        })), sessionId ? { sessionId } : {});
        const uploadedFiles = finalized.map((file) => file.info);
        uploadLogger.info(`Upload complete request=${requestId} files=${uploadedFiles.length} bytes=${uploadedFiles.reduce((sum, file) => sum + file.size, 0)}`);
        if (!res.writableEnded) {
          res.setHeader('X-Upload-Request-Id', requestId);
          res.json({ success: true, requestId, files: uploadedFiles });
        }
      } catch (error) {
        await uploadManager.finishFailedRequest(requestId, 'failed');
        if (error instanceof UploadPolicyError) {
          uploadLogger.warn(`Upload policy rejected request=${requestId} code=${error.code}`);
          if (!res.headersSent && !res.writableEnded) {
            res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
          }
          return;
        }
        uploadLogger.error(`Upload finalize failed request=${requestId}:`, error);
        if (!res.headersSent && !res.writableEnded) {
          res.status(500).json({ success: false, error: 'Upload failed', code: 'UPLOAD_FINALIZE_FAILED' });
        }
      }
    });
  });

  router.get('/uploads/requests/:requestId', async (req, res) => {
    const requestId = req.params.requestId;
    if (!UPLOAD_REQUEST_ID_RE.test(requestId)) {
      res.status(400).json({ success: false, code: 'UPLOAD_REQUEST_ID_INVALID', error: 'uploadRequestId 格式无效' });
      return;
    }
    const userCwd = resolveRequestUserCwd(agentCwd, req);
    const files = await uploadManager.getCompletedRequest(userCwd, requestId);
    if (!files) {
      res.status(404).json({ success: false, requestId, code: 'UPLOAD_REQUEST_NOT_FOUND' });
      return;
    }
    res.json({ success: true, requestId, files });
  });

  router.post('/upload/:requestId/cancel', async (req, res) => {
    const requestId = req.params.requestId;
    if (!UPLOAD_REQUEST_ID_RE.test(requestId)) {
      res.status(400).json({ success: false, code: 'UPLOAD_REQUEST_ID_INVALID', error: 'uploadRequestId 格式无效' });
      return;
    }
    const userCwd = resolveRequestUserCwd(agentCwd, req);
    const outcome = await uploadManager.cancelRequest(userCwd, requestId);
    res.status(outcome === 'not_found' ? 404 : 200).json({ success: outcome !== 'not_found', requestId, outcome });
  });

  const serveAttachmentContent = async (req: Request, res: import('express').Response): Promise<void> => {
    try {
      const userCwd = resolveRequestUserCwd(agentCwd, req);
      const content = await uploadManager.getAttachmentContent(userCwd, req.params.attachmentId);
      const audio = INLINE_AUDIO_MIME_TYPES.has(content.mimeType.toLowerCase());
      const inline = req.query.download !== '1' && (content.isImage || audio);
      for (const [name, value] of Object.entries(attachmentResponseHeaders({
        originalName: content.originalName, mimeType: content.mimeType, inline,
      }))) res.setHeader(name, value);
      res.setHeader('Accept-Ranges', 'bytes');

      const range = parseAttachmentRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, content.size);
      if (range === 'invalid') {
        res.setHeader('Content-Range', `bytes */${content.size}`);
        res.status(416).end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, content.size - 1);
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${content.size}`);
      } else {
        res.status(200);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(content.absolutePath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) res.status(410).json({ success: false, code: 'ATTACHMENT_DELETED', error: '附件已删除' });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      if (error instanceof AttachmentUnavailableError) {
        res.status(error.code === 'ATTACHMENT_NOT_FOUND' ? 404 : 410).json({ success: false, code: error.code, error: error.message });
        return;
      }
      res.status(404).json({ success: false, code: 'ATTACHMENT_NOT_FOUND', error: '附件不存在或无权访问' });
    }
  };
  router.get('/attachments/:attachmentId/content', serveAttachmentContent);
  router.head('/attachments/:attachmentId/content', serveAttachmentContent);

  // Usage and cleanup endpoints remain separate from byte-stream playback.
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

  router.delete('/uploads/all', async (req, res) => {
    try {
      const userCwd = resolveRequestUserCwd(agentCwd, req);
      const result = await uploadManager.purgeUserUploads(userCwd);
      uploadLogger.warn(`Manual purge of all attachments user=${req.user?.username ?? 'anonymous'} files=${result.deletedFiles} bytes=${result.deletedBytes}`);
      res.json({ success: true, ...result });
    } catch (error) {
      uploadLogger.error('Failed to purge attachments:', error);
      res.status(500).json({ success: false, error: '清空附件失败' });
    }
  });

  return router;
}
