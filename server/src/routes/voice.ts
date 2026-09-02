/** M50-04 path-free voice transcription routes. Audio playback uses GET /attachments/:attachmentId/content. */
import { Router, type Request } from 'express';
import { resolveUserCwd } from '../workspace/resolver.js';
import {
  VoiceTranscriptionError,
  type VoiceTranscriptionService,
} from '../services/voiceTranscriptionService.js';

export interface VoiceRouterOptions {
  agentCwd: string;
  transcriptionService: VoiceTranscriptionService;
}

function requestUserCwd(agentCwd: string, req: Request): string {
  const user = req.user;
  return resolveUserCwd(agentCwd, user ? {
    id: user.sub,
    username: user.username,
    role: user.role,
    tenantId: user.tenantId,
  } : undefined);
}

export function createVoiceRouter(options: VoiceRouterOptions): Router {
  const router = Router();

  router.post('/voice/transcriptions', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const result = await options.transcriptionService.request(requestUserCwd(options.agentCwd, req), {
        requestId: typeof body.requestId === 'string' ? body.requestId : '',
        attachmentId: typeof body.attachmentId === 'string' ? body.attachmentId : '',
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : Number.NaN,
      });
      res.status(result.idempotentReplay ? 200 : 201).json({ success: true, result });
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) {
        res.status(error.statusCode).json({
          success: false,
          error: { code: error.code, message: error.message, retryable: error.code === 'STT_TIMEOUT' || error.code === 'STT_PROVIDER_ERROR' },
        });
        return;
      }
      res.status(500).json({
        success: false,
        error: { code: 'STT_PROVIDER_ERROR', message: '语音识别服务异常', retryable: true },
      });
    }
  });

  // The legacy path query endpoint is deliberately gone. This explicit response prevents a stale
  // client from turning a workspace/local path into a durable playback URL.
  router.get('/voice/play', (_req, res) => {
    res.status(410).json({
      success: false,
      error: { code: 'VOICE_PATH_PLAYBACK_REMOVED', message: '请使用鉴权附件 ID 回放语音' },
    });
  });

  return router;
}
