import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../app/config.js';
import { parseAppConfig } from '../app/config.js';
import {
  buildCanonicalConfigProjection,
  calculateConfigIdentityDigest,
} from './configIdentity.js';

function config(overrides: Record<string, unknown>): AppConfig {
  return parseAppConfig({
    agent: { cwd: '/srv/agent', permissionMode: 'default' },
    server: { port: 3001, timezone: 'Asia/Shanghai' },
    ...overrides,
  });
}

function digestOf(value: AppConfig): string {
  const { projection } = buildCanonicalConfigProjection(value, '/srv/server');
  return calculateConfigIdentityDigest(projection);
}

describe('canonical projection 自由文本', () => {
  it('system prompt 与工具 descriptionOverride 文本仅以 opaque digest 投影', () => {
    const firstPrompt = 'private-prompt-token /home/alice/prompt-source';
    const secondPrompt = 'changed-private-prompt-token /home/bob/prompt-source';
    const firstDescription = 'private-description-token /srv/private/tool.md';
    const secondDescription = 'changed-private-description-token /opt/private/tool.md';
    const first = config({
      systemPrompts: { 'utility.title': firstPrompt },
      toolControls: {
        tools: {
          Shell: { descriptionOverride: { mode: 'append', text: firstDescription } },
        },
      },
    });
    const changedPrompt = config({
      systemPrompts: { 'utility.title': secondPrompt },
      toolControls: first.toolControls,
    });
    const changedDescription = config({
      systemPrompts: first.systemPrompts,
      toolControls: {
        tools: {
          Shell: { descriptionOverride: { mode: 'append', text: secondDescription } },
        },
      },
    });

    const serialized = JSON.stringify(buildCanonicalConfigProjection(first, '/srv/server').projection);
    for (const plaintext of [
      firstPrompt,
      'private-prompt-token',
      '/home/alice/prompt-source',
      firstDescription,
      'private-description-token',
      '/srv/private/tool.md',
    ]) {
      expect(serialized).not.toContain(plaintext);
    }
    expect(serialized.match(/__opaqueDigest__/gu)).toHaveLength(2);
    expect(digestOf(changedPrompt)).not.toBe(digestOf(first));
    expect(digestOf(changedDescription)).not.toBe(digestOf(first));
  });
});
