import { describe, expect, it } from 'vitest';
import {
  composeToolNameResolver,
  normalizeInternalToolNameStrategy,
  resolveDisplayToolName,
  resolveMcpToolNameStrategy,
  resolveSkillToolNameStrategy,
} from '../channels/toolNameResolver.js';

describe('toolNameResolver strategies', () => {
  it('normalizes internal tool names', () => {
    expect(resolveDisplayToolName({ toolId: '1', toolName: 'bash', toolInput: '' })).toBe('Bash');
    expect(resolveDisplayToolName({ toolId: '2', toolName: 'Read', toolInput: '' })).toBe('Read');
  });

  it('formats MCP tool names', () => {
    expect(resolveDisplayToolName({ toolId: '1', toolName: 'mcp__github__create_issue', toolInput: '' }))
      .toBe('MCP:github/create_issue');
    expect(resolveDisplayToolName({ toolId: '2', toolName: 'mcp__notion__databases__query', toolInput: '' }))
      .toBe('MCP:notion/databases__query');
  });

  it('resolves Skill name from tool input json', () => {
    expect(resolveDisplayToolName({
      toolId: '1',
      toolName: 'Skill',
      toolInput: '{"skill":"commit"}',
    })).toBe('Skill:commit');
  });

  it('supports composed strategies with deterministic order', () => {
    const resolver = composeToolNameResolver([
      normalizeInternalToolNameStrategy,
      resolveMcpToolNameStrategy,
      resolveSkillToolNameStrategy,
    ]);

    expect(resolver({
      toolId: 'x',
      toolName: 'skill',
      toolInput: '{"skill":"release"}',
    })).toBe('Skill:release');
  });
});
