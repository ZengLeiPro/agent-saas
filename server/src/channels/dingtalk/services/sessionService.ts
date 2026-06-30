import type { DingtalkSessionStore, SaveSessionOptions } from '../types.js';
import {
  loadDingtalkSessions,
  saveClaudeSession,
  clearDingtalkSession,
  getClaudeSession,
  getModelRef,
  saveModelRef,
} from '../../../data/sessions/dingtalkSessionStore.js';

export interface DingtalkSessionService {
  loadSessions(): DingtalkSessionStore;
  getClaudeSession(conversationId: string): string | undefined;
  saveClaudeSession(options: SaveSessionOptions): void;
  clearSession(conversationId: string): void;
  getModelRef(conversationId: string): string | undefined;
  saveModelRef(conversationId: string, modelRef: string | undefined): void;
}

export function createDingtalkSessionService(basePath: string): DingtalkSessionService {
  return {
    loadSessions(): DingtalkSessionStore {
      return loadDingtalkSessions(basePath);
    },
    getClaudeSession(conversationId: string): string | undefined {
      return getClaudeSession(conversationId, basePath);
    },
    saveClaudeSession(options: SaveSessionOptions): void {
      saveClaudeSession(options, basePath);
    },
    clearSession(conversationId: string): void {
      clearDingtalkSession(conversationId, basePath);
    },
    getModelRef(conversationId: string): string | undefined {
      return getModelRef(conversationId, basePath);
    },
    saveModelRef(conversationId: string, modelRef: string | undefined): void {
      saveModelRef(conversationId, modelRef, basePath);
    },
  };
}
