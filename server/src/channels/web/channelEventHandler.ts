import { stat } from 'fs/promises';
import { resolve as resolvePath } from 'path';
import type { WebSocket } from 'ws';
import { projectArtifactDelivery, shouldSendWebBlock, shouldSendWebToolResult } from './displayFilter.js';
import { chatLogger } from '../../utils/logger.js';
import { parseVoiceMarkers } from '../../utils/voiceMarkers.js';
import { FILE_MARKER_PATTERN, MEDIA_MARKER_CLEAN_RE } from '../../integrations/dingtalk/constants.js';
import type { ChannelContext, OutboundEvent, WebMessageDisplayConfig } from '../../types/index.js';
import { createEventConsumer, type EventHandler } from '../eventConsumer.js';
import { canViewContextUsageDetails, redactContextUsageDetails } from './channelHelpers.js';
import { getTranscriptPath, deleteSession } from '../../data/transcripts/index.js';
import { readSessionMeta, writeSessionMeta, type SessionMeta } from '../../data/transcripts/meta.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import { clearSessionsListCache } from '../../routes/sessions.js';
import { shouldGenerateTitleFromFirstMessage } from '../../agent/titleGenerator.js';
import type { TenantStore } from '../../data/tenants/store.js';
import { EventBufferStore } from './eventBuffer.js';
import { EventBus, type SessionContext } from './eventBus.js';

export interface WebChannelEventDependencies {
  displayConfig: WebMessageDisplayConfig;
  agentCwd?: string;
  tenantStore?: TenantStore;
  eventBus: EventBus;
  eventBufferStore: EventBufferStore;
  setIdempotency(userId: string | undefined, clientMsgId: string, status: 'done' | 'failed', streamId: string): void;
  generateTitle(
    sessionId: string,
    context: ChannelContext,
    userMessage: string,
    assistantReply: string,
    retryAfterInFlightFailure?: boolean,
  ): Promise<string | null>;
}

export interface WebChannelEventTitleContext {
  userMessage: string;
  userDisplayContent?: string;
  attachmentMeta?: Array<{ name: string; isImage?: boolean; relativePath?: string }>;
  clientMsgId?: string;
  isNewSession: boolean;
  getSessionId: () => string | undefined;
}

export async function handleWebChannelEvents(
  dependencies: WebChannelEventDependencies,
  events: AsyncGenerator<OutboundEvent>,
  ws: WebSocket,
  context: ChannelContext,
  signal?: AbortSignal,
  bufferCtx?: { sessionId?: string; streamId?: string },
  titleCtx?: WebChannelEventTitleContext,
  modelRef?: string,
  clientMsgId?: string,
): Promise<void> {
    const config = dependencies.displayConfig;
    // 会话上下文（sessionId 由 onSessionInit 填充，streamId 提前已知）
    const sessionCtx: SessionContext = {
      sessionId: bufferCtx?.sessionId || '',
      streamId: bufferCtx?.streamId || '',
      ws,
      userId: context.user?.id,
    };
    const send = (data: object) => {
      if (sessionCtx.sessionId) {
        dependencies.eventBus.emitSession(sessionCtx, data);
      } else {
        // EventBuffer 尚未建立（session_init 之前），直发
        dependencies.eventBus.emitReply(ws, data);
      }
    };

    const sendVoiceMarkers = (text: string, standalone: boolean) => {
      const parsed = parseVoiceMarkers(text);
      for (const marker of parsed.markers) {
        send({
          type: 'voice',
          text: marker.text,
          voice: marker.voice,
          speed: marker.speed,
          standalone,
        });
      }
    };

    // ---- 每个 text block 的缓冲状态 ----
    let textBuffer: string[] = [];
    let textAccumulated = '';
    let isBuffering = true;
    let textBlockStartSent = false;
    let textDraftId: string | undefined;

    const flushTextBuffer = () => {
      if (!textBlockStartSent) {
        send({
          type: 'block_start',
          blockType: 'text',
          ...(textDraftId ? { draftId: textDraftId } : {}),
        });
        textBlockStartSent = true;
      }
      for (const chunk of textBuffer) {
        send({ type: 'text', content: chunk });
      }
      textBuffer = [];
      isBuffering = false;
    };

    const resetTextBlockState = () => {
      textBuffer = [];
      textAccumulated = '';
      isBuffering = true;
      textBlockStartSent = false;
      textDraftId = undefined;
    };

    let collectedAssistantText = '';
    const draftCollectedTextStarts = new Map<string, number>();
    // SDK 错误透传：onError 记录，onDone 合并进 done 事件
    let lastError: string | undefined;

    // ---- 幽灵会话检测 ----
    // 新会话必须至少产生过一次"真实内容"事件（text/thinking/tool），
    // 否则在流结束时删除，避免用户刷新/断连/立刻取消产生的空「新对话」污染列表。
    // 之前的 isNewSession 与 titleCtx 同体，命名扩成"每轮都尝试"后两者解耦。
    const isNewSession = titleCtx?.isNewSession ?? false;
    let hasRealContent = false;
    const markRealContent = () => { hasRealContent = true; };

    const agentCwd = dependencies.agentCwd;
    const handler: EventHandler = {
      async onSessionInit(sessionId) {
        if (bufferCtx && sessionId) {
          bufferCtx.sessionId = sessionId;
          sessionCtx.sessionId = sessionId;
          dependencies.eventBufferStore.create(sessionId, context.user?.id);
          // 新建会话：注入用户消息到 buffer（其他设备 resume 时会 replay）
          // 续聊不该重发 user_message，靠 isNewSession 守卫——之前用 titleCtx 存在与否兼任此判断，
          // 命名上下文改成每轮都构造后，此处必须显式判断会话新旧。
          if (isNewSession && (titleCtx?.userDisplayContent || titleCtx?.attachmentMeta)) {
            dependencies.eventBufferStore.push(sessionId, JSON.stringify({
              type: 'user_message',
              content: titleCtx?.userDisplayContent ?? '',
              ...(titleCtx?.attachmentMeta?.length ? { attachments: titleCtx.attachmentMeta } : {}),
              timestamp: Date.now(),
              ...(titleCtx?.clientMsgId ? { client_msg_id: titleCtx.clientMsgId } : {}),
            }));
            // B 修复：user_message 已进 EventBuffer，本会话视为"有真实内容"，
            // 防止 SDK 在 session_init 后立刻 error 时幽灵回滚连带删除用户消息。
            markRealContent();
          }
        }
        if (context.user && agentCwd && sessionId) {
          // Admin 代操作其他用户会话时，meta 必须写回原会话 owner 的目录，
          // 否则会在 admin 自己的 projectKey 下产生孤儿 meta，污染 owner 展示。
          const metaCwd = context.targetCwd || resolveUserCwd(agentCwd, {
            id: context.user.id,
            username: context.user.username,
            role: context.user.role as 'admin' | 'user',
            tenantId: context.user.tenantId,
          });
          const transcriptPath = getTranscriptPath(metaCwd, sessionId, { tenantId: context.user.tenantId, userId: context.user.id });
          try {
            const existing = await readSessionMeta(transcriptPath);
            if (existing) {
              // 续对话：只更新 model，保留已有的所有字段（customTitle、generatedTitle、createdAt 等）
              const ownerRole = context.sessionOwner?.role ?? context.user.role;
              const updated: SessionMeta = {
                ...existing,
                userRole: existing.userRole ?? ownerRole,
                ...(modelRef ? { model: modelRef } : {}),
              };
              await writeSessionMeta(transcriptPath, updated);
            } else {
              // 新会话：写完整初始 meta
              const meta: SessionMeta = {
                userId: context.user.id,
                username: context.user.username,
                userRole: context.user.role,
                tenantId: context.user.tenantId,
                channel: 'web',
                createdAt: new Date().toISOString(),
                ...(modelRef ? { model: modelRef } : {}),
              };
              await writeSessionMeta(transcriptPath, meta);
            }
          } catch (err) {
            chatLogger.warn(`[meta] Failed to write session meta before session event: sessionId=${sessionId} user=${context.user.username} error=${err}`);
            throw err;
          }
        }
        // 分组写入会同步校验 owner meta；必须在 meta 落盘后再把权威 sessionId 发给客户端。
        send({ type: 'session', sessionId, ...(titleCtx?.clientMsgId ? { client_msg_id: titleCtx.clientMsgId } : {}) });
        // 新会话创建后立即清除缓存，确保客户端 loadSessions() 能发现新会话
        clearSessionsListCache();
        if (
          context.user
          && agentCwd
          && isNewSession
          && titleCtx?.userMessage
          && shouldGenerateTitleFromFirstMessage(titleCtx.userMessage)
        ) {
          void dependencies.generateTitle(sessionId, context, titleCtx.userMessage, '').catch((err) => {
            chatLogger.warn(`[title] Failed to generate session title: sessionId=${sessionId} user=${context.user?.username} error=${err}`);
          });
        }
        // 新会话场景：广播 stream_started + session_status + session_updated 到同用户的其他连接
        if (context.user?.id && dependencies.eventBus && sessionId) {
          dependencies.eventBus.emitUser(context.user.id, {
            type: 'stream_started',
            sessionId,
            streamId: bufferCtx?.streamId || '',
          }, ws);
          dependencies.eventBus.emitUser(context.user.id, {
            type: 'session_status',
            sessionId,
            status: 'busy',
            streamId: bufferCtx?.streamId || '',
          });
          // 通知所有连接新会话已创建（不排除发起方），可直接 upsert 到本地列表
          dependencies.eventBus.emitDual(context.user.id, sessionId, {
            type: 'session_updated',
            sessionId,
            updatedAtMs: Date.now(),
            isNew: true,
            username: context.user.username,
            model: modelRef || undefined,
          });
        }
      },

      onThinkingStart(draftId) {
        markRealContent();
        if (draftId && !draftCollectedTextStarts.has(draftId)) {
          draftCollectedTextStarts.set(draftId, collectedAssistantText.length);
        }
        if (shouldSendWebBlock('thinking', undefined, config)) {
          send({
            type: 'block_start',
            blockType: 'thinking',
            ...(draftId ? { draftId } : {}),
          });
        }
      },
      onThinkingDelta(content) {
        if (shouldSendWebBlock('thinking', undefined, config)) {
          send({ type: 'thinking', content });
        }
      },
      onThinkingEnd() {
        if (shouldSendWebBlock('thinking', undefined, config)) {
          send({ type: 'block_end', blockType: 'thinking' });
        }
      },

      onTextStart(draftId) {
        markRealContent();
        resetTextBlockState();
        textDraftId = draftId;
        if (draftId && !draftCollectedTextStarts.has(draftId)) {
          draftCollectedTextStarts.set(draftId, collectedAssistantText.length);
        }
      },

      onTextDelta(content) {
        textAccumulated += content;
        // 命名上下文每轮都构造，因此 collectedAssistantText 也每轮累积前 500 字符——
        // 作 transcript 尚未落盘时的 fallback；超过 500 即停止累积，避免大流额外内存压力。
        if (collectedAssistantText.length < 500) {
          collectedAssistantText += content;
        }

        if (isBuffering) {
          textBuffer.push(content);
          const trimmed = textAccumulated.trimStart();
          const couldBeVoice = trimmed.length === 0
            || '[VOICE'.startsWith(trimmed)
            || trimmed.startsWith('[VOICE');
          if (!couldBeVoice) {
            flushTextBuffer();
          }
        } else {
          if (!textBlockStartSent) {
            send({ type: 'block_start', blockType: 'text' });
            textBlockStartSent = true;
          }
          send({ type: 'text', content });
        }
      },

      async onTextEnd(blockText) {
        const parsed = parseVoiceMarkers(blockText);
        const hasVoice = parsed.markers.length > 0;
        const cleanedText = parsed.cleanedText.replace(new RegExp(MEDIA_MARKER_CLEAN_RE.source, 'g'), '').trim();
        const hasText = cleanedText.length > 0;

        if (isBuffering) {
          if (hasVoice && !hasText) {
            sendVoiceMarkers(blockText, true);
          } else if (hasVoice && hasText) {
            send({
              type: 'block_start',
              blockType: 'text',
              ...(textDraftId ? { draftId: textDraftId } : {}),
            });
            send({ type: 'text', content: cleanedText });
            send({ type: 'block_end', blockType: 'text' });
            sendVoiceMarkers(blockText, false);
          } else if (hasText) {
            send({
              type: 'block_start',
              blockType: 'text',
              ...(textDraftId ? { draftId: textDraftId } : {}),
            });
            send({ type: 'text', content: cleanedText });
            send({ type: 'block_end', blockType: 'text' });
          }
        } else {
          send({ type: 'block_end', blockType: 'text' });
          if (hasVoice) {
            sendVoiceMarkers(blockText, false);
          }
        }

        // FILE 标记处理
        const fileMatches = [...blockText.matchAll(new RegExp(FILE_MARKER_PATTERN.source, 'g'))];
        for (const match of fileMatches) {
          try {
            const payload = JSON.parse(match[1]);
            const filePath: string = payload.filePath || payload.path;
            if (!filePath) continue;

            const userCwd = context.user && agentCwd
              ? resolveUserCwd(agentCwd, { id: context.user.id, username: context.user.username, role: context.user.role as 'admin' | 'user', tenantId: context.user.tenantId })
              : agentCwd || '';
            const absoluteFilePath = resolvePath(userCwd, filePath);
            const fileStat = await stat(absoluteFilePath).catch(() => null);
            if (!fileStat || !fileStat.isFile()) continue;

            const relativePath = absoluteFilePath.startsWith(userCwd + '/')
              ? absoluteFilePath.slice(userCwd.length + 1)
              : filePath;

            send({
              type: 'file_download',
              fileName: payload.fileName || absoluteFilePath.split('/').pop() || 'file',
              fileType: payload.fileType || '',
              filePath: relativePath,
              fileSize: fileStat.size,
              ...(context.user ? { owner: context.user.username } : {}),
            });
          } catch {
            // 解析失败，跳过
          }
        }

        resetTextBlockState();
      },

      onDraftReset(draftId, attempt) {
        const start = draftCollectedTextStarts.get(draftId);
        if (start !== undefined) {
          collectedAssistantText = collectedAssistantText.slice(0, start);
        }
        resetTextBlockState();
        send({
          type: 'draft_reset',
          draftId,
          ...(attempt !== undefined ? { attempt } : {}),
        });
      },

      onDraftCommit(draftId) {
        draftCollectedTextStarts.delete(draftId);
        send({ type: 'draft_commit', draftId });
      },

      onToolStart(toolId, toolName, _tracker, runId) {
        markRealContent();
        if (shouldSendWebBlock('tool_use', toolName, config)) {
          send({
            type: 'block_start',
            blockType: 'tool_use',
            toolName,
            toolId,
            ...(runId ? { runId } : {}),
          });
        }
      },
      onToolInputDelta(partialJson, toolId, toolName) {
        if (shouldSendWebBlock('tool_use', toolName, config)) {
          send({
            type: 'tool_input',
            content: partialJson,
            toolName,
            toolId,
          });
        }
      },
      onToolEnd(_toolId, resolvedToolName) {
        if (shouldSendWebBlock('tool_use', resolvedToolName, config)) {
          send({ type: 'block_end', blockType: 'tool_use', toolName: resolvedToolName });
        }
      },

      onToolResult(toolId, toolName, result, isError, presentation, metadata) {
        const artifactDelivery = projectArtifactDelivery(toolName, metadata, result);
        if (artifactDelivery) {
          send(artifactDelivery);
          return;
        }
        if (shouldSendWebToolResult(toolName, config)) {
          send({
            type: 'tool_result',
            toolId,
            toolName,
            result,
            ...(isError ? { isError: true } : {}),
            ...(presentation ? { presentation } : {}),
            ...(metadata ? { metadata } : {}),
          });
        }
      },

      async onDone() {
        // done 事件携带 client_msg_id + 可选 error（SDK 错误时由 onError 写入 lastError）
        // 多设备兜底：finally 块会广播 session_status idle（user scope，含 UserEventLog），
        // 其他设备通过 session_status 匹配 sessionId 独立清 loading，不依赖 done 跨 WS 广播。
        send({
          type: 'done',
          ...(clientMsgId ? { client_msg_id: clientMsgId } : {}),
          ...(!lastError && collectedAssistantText.trim() ? { finalOutput: true } : {}),
          ...(lastError ? { error: lastError } : {}),
        });
        // 更新幂等记录终态
        if (clientMsgId) {
          dependencies.setIdempotency(context.user?.id, clientMsgId, lastError ? 'failed' : 'done', bufferCtx?.streamId ?? '');
        }
        // 元数据事件统一走 broadcastToUser（不排除发起方）——消除 send() isActive 守卫导致的事件黑洞
        const updatedSid = titleCtx?.getSessionId() ?? bufferCtx?.sessionId;
        if (updatedSid && context.user?.id && dependencies.eventBus) {
          dependencies.eventBus.emitDual(context.user.id, updatedSid, {
            type: 'session_updated',
            sessionId: updatedSid,
            preview: collectedAssistantText.slice(0, 200) || undefined,
            updatedAtMs: Date.now(),
          });
        }
        // 立即清除缓存，确保客户端收到 done/session_updated 后 loadSessions() 不命中旧缓存
        clearSessionsListCache();
        // 所有终态都尝试补齐标题：正常完成、SDK error、用户停止、纯工具/纯思考
        // 都不会再留下永久无标题会话。已有标题与并发触发由统一入口幂等吸收。
        if (titleCtx) {
          const sid = titleCtx.getSessionId();
          if (sid) {
            await dependencies.generateTitle(sid, context, titleCtx.userMessage, collectedAssistantText, true);
          }
        }
      },
      onError(error) {
        // 用户主动停止后 SDK 通常仍会产出 AbortError；这是正常取消，不是运行失败。
        // 不写入 lastError，避免 onDone 把用户消息标红并显示错误卡。
        if (signal?.aborted && signal.reason === 'web_abort') {
          chatLogger.info(`[chat] SDK stream stopped by user for client_msg_id=${clientMsgId}`);
          return;
        }
        // SDK 错误：记录 error 供 onDone 合并到 done 事件，不再单发 error
        // （客户端收到 done + error 后会清理 loading 状态 + 显示错误文案，无需靠 watchdog 兜底）
        lastError = error;
        chatLogger.error(`[chat] SDK error for client_msg_id=${clientMsgId}: ${error}`);
      },
      // SDK 0.2.112+ 新事件透传
      onContextUsage(usage) {
        send({
          type: 'context_usage',
          contextUsage: canViewContextUsageDetails(context, dependencies.tenantStore)
            ? usage
            : redactContextUsageDetails(usage),
        });
      },
      onPluginInstall(data) {
        send({ type: 'plugin_install', pluginInstall: data });
      },
      onNotification(data) {
        // REPL 级通知跨会话可见，走 user scope
        if (context.user?.id && dependencies.eventBus) {
          dependencies.eventBus.emitUser(context.user.id, { type: 'notification', notification: data });
        } else {
          send({ type: 'notification', notification: data });
        }
      },
      onMemoryRecall(data) {
        send({ type: 'memory_recall', memoryRecall: data });
      },
      // /compact v2：压缩黑箱状态透传。enqueue 路径由 publishRuntimeOutboundEvent
      // 映射为 compaction_status，此处补齐 dispatch 直连路径的同口径事件。
      onCompactionStart() {
        send({ type: 'compaction_status', phase: 'started' });
      },
      onCompactionEnd(data) {
        send({ type: 'compaction_status', phase: 'completed', compaction: data });
      },
    };

    const consumer = createEventConsumer();
    try {
      await consumer.consume(events, handler, signal);
    } finally {
      // 幽灵会话回滚：新会话从未产生任何真实内容（用户刷新/断连/立刻取消/SDK 只写了 system init）
      const phantomSessionId = bufferCtx?.sessionId;
      if (isNewSession && !hasRealContent && phantomSessionId && context.user && agentCwd) {
        const metaCwd = context.targetCwd || resolveUserCwd(agentCwd, {
          id: context.user.id,
          username: context.user.username,
          role: context.user.role as 'admin' | 'user',
          tenantId: context.user.tenantId,
        });
        const transcriptPath = getTranscriptPath(metaCwd, phantomSessionId, { tenantId: context.user.tenantId, userId: context.user.id });
        try {
          await deleteSession(phantomSessionId, { deleteSidecarDir: true });
          chatLogger.info(`[phantom-session] Rolled back empty session ${phantomSessionId} (user=${context.user.username}) path=${transcriptPath}`);
        } catch (err) {
          chatLogger.warn(`[phantom-session] Failed to delete ${phantomSessionId}: ${err}`);
        }
        // 清理 EventBuffer（用户其他设备不再能 resume 到这个会话）
        try { dependencies.eventBufferStore.remove(phantomSessionId); } catch { /* noop */ }
        // 通知所有设备从列表移除（onSessionInit 已经 emit 过 session_updated isNew:true）
        if (dependencies.eventBus) {
          dependencies.eventBus.emitUser(context.user.id, {
            type: 'session_deleted',
            sessionId: phantomSessionId,
          });
        }
        clearSessionsListCache();
      }
    }
}
