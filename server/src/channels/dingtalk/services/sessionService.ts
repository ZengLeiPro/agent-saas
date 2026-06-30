import type { DingtalkSessionStore, SaveSessionOptions } from '../types.js';
import {
  loadDingtalkSessions,
  saveAgentSession,
  clearDingtalkSession,
  getAgentSession,
  getModelRef,
  saveModelRef,
} from '../../../data/sessions/dingtalkSessionStore.js';

export interface DingtalkSessionService {
  loadSessions(): DingtalkSessionStore;
  getAgentSession(conversationId: string): string | undefined;
  saveAgentSession(options: SaveSessionOptions): void;
  clearSession(conversationId: string): void;
  getModelRef(conversationId: string): string | undefined;
  saveModelRef(conversationId: string, modelRef: string | undefined): void;
}

export function createDingtalkSessionService(basePath: string): DingtalkSessionService {
  return {
    loadSessions(): DingtalkSessionStore {
      return loadDingtalkSessions(basePath);
    },
    getAgentSession(conversationId: string): string | undefined {
      return getAgentSession(conversationId, basePath);
    },
    saveAgentSession(options: SaveSessionOptions): void {
      saveAgentSession(options, basePath);
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
