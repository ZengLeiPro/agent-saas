import { describe, expect, it, vi } from 'vitest';
import {
  generateTitle,
  type TitleGeneratorConfig,
  type TitleModelAdapterFactory,
} from '../agent/titleGenerator.js';
const grok: TitleGeneratorConfig = {
  model: 'same-model',
  protocol: 'responses',
  responsesTransport: 'grok_subscription',
};
const options = (factory: TitleModelAdapterFactory, sessionId: string) => ({
  modelAdapterFactory: factory,
  runtimeContext: { sessionId, cwd: '/tmp/grok-title' },
  timeoutMs: 5,
});
describe('Subscription title hanging-operation guard', () => {
  it('does not start a second Grok request in another session or renamed alias while the first ignores abort', async () => {
    const factory = vi.fn(() => ({
      stream: async function* () {
        await new Promise<never>(() => {});
      },
    }));
    expect(
      await generateTitle('u', 'a', grok, undefined, undefined, options(factory, 'first')),
    ).toBeNull();
    expect(
      await generateTitle(
        'u2',
        'a2',
        { ...grok, modelRef: 'renamed/alias' },
        undefined,
        undefined,
        options(factory, 'second'),
      ),
    ).toBeNull();
    expect(factory).toHaveBeenCalledOnce();
  });
  it('a hanging Codex request does not block a distinct Grok provider with the same model name', async () => {
    const factory = vi.fn<TitleModelAdapterFactory>((_connection, provider) => ({
      stream: async function* () {
        if (provider?.responsesTransport === 'codex_subscription')
          await new Promise<never>(() => {});
        yield {
          type: 'completed' as const,
          content: '提供方隔离',
          toolCalls: [],
          terminalStatus: 'completed' as const,
        };
      },
    }));
    expect(
      await generateTitle(
        'u',
        'a',
        { ...grok, responsesTransport: 'codex_subscription' },
        undefined,
        undefined,
        options(factory, 'codex'),
      ),
    ).toBeNull();
    expect(
      await generateTitle('u', 'a', grok, undefined, undefined, options(factory, 'grok')),
    ).toBe('提供方隔离');
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it('releases only after a finished operation so later sessions can generate their own title', async () => {
    const factory = vi.fn(() => ({
      stream: async function* () {
        yield {
          type: 'completed' as const,
          content: '完成后释放',
          toolCalls: [],
          terminalStatus: 'completed' as const,
        };
      },
    }));
    for (const id of ['first', 'second'])
      expect(await generateTitle('u', 'a', grok, undefined, undefined, options(factory, id))).toBe(
        '完成后释放',
      );
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
