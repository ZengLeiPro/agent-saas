// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@agent/shared';
import type { SessionState } from './useSession';
import {
  projectInteractionRequest,
  projectInteractionResolution,
  rememberResolvedInteraction,
} from '@agent/shared';

const h = vi.hoisted(() => ({
  authFetch: vi.fn(),
  cacheSave: vi.fn(),
  latest: null as SessionState | null,
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    authFetch: h.authFetch,
    getPlatform: () => ({
      storage: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
      },
    }),
  };
});

vi.mock('../platform/mobileMessageCache', () => ({
  createMobileMessageCacheForIdentity: () => ({
    load: vi.fn(async () => null),
    save: h.cacheSave,
    clear: vi.fn(async () => undefined),
  }),
}));

vi.mock('../lib/sessionListCache', () => ({
  saveSessionListCache: vi.fn(async () => undefined),
  loadSessionListCache: vi.fn(async () => null),
}));

import { useSession } from './useSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useSession pending interaction reconciliation', () => {
  let messages: MessageItem[];
  let resolvedKeys: Set<string>;

  beforeEach(() => {
    messages = [];
    resolvedKeys = new Set();
    h.latest = null;
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  it('does not revive an interaction when a stale HTTP pending response arrives after its terminal event', async () => {
    const pendingResponse = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    h.authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/sessions/session-1?')) {
        return {
          ok: true,
          json: async () => ({ sessionId: 'session-1', blocks: [], hasMore: false }),
        };
      }
      if (url.startsWith('/api/chat/interactions/pending?')) return pendingResponse.promise;
      if (url.startsWith('/api/sessions/session-1/token-usage')) {
        return { ok: false, json: async () => null };
      }
      return { ok: false, json: async () => null };
    });

    function Harness() {
      h.latest = useSession({
        resetMessages: () => {
          messages = [];
        },
        setMessages: (next) => {
          messages = next;
        },
        getMessages: () => messages,
        getResolvedInteractionIds: () => resolvedKeys,
        triggerScroll: vi.fn(),
        cancelActiveStream: vi.fn(),
        clearComposer: vi.fn(),
      });
      return null;
    }

    render(<Harness />);
    await act(async () => {
      await h.latest!.loadSessionDetail('session-1');
    });
    await waitFor(() =>
      expect(h.authFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/chat/interactions/pending?'),
      ),
    );

    const request = {
      type: 'ask_user' as const,
      interactionId: 'ask-1',
      version: 1,
      order: 1,
      questions: [{ question: '选哪个？', header: '选择', options: [], multiSelect: false }],
    };
    messages = projectInteractionRequest(messages, request);
    messages = projectInteractionResolution(messages, 'ask-1', { answers: { '选哪个？': 'A' } });
    rememberResolvedInteraction(resolvedKeys, 'session-1', 'ask-1');

    await act(async () => {
      pendingResponse.resolve({ ok: true, json: async () => [request] });
      await pendingResponse.promise;
    });
    await waitFor(() => {
      expect(
        messages.some(
          (message) =>
            (message.type === 'ask_user' || message.type === 'permission_request') &&
            message.interactionId === 'ask-1' &&
            message.status === 'pending',
        ),
      ).toBe(false);
      expect(
        messages.some(
          (message) => message.type === 'runtime_status' && message.status === 'waiting_user',
        ),
      ).toBe(false);
    });
  });
});
