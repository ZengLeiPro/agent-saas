import { describe, expect, it } from 'vitest';

import { toolNameForSandboxRunner } from './executor.js';

describe('toolNameForSandboxRunner', () => {
  it('keeps the current brain-facing workspace tool names compatible with the deployed sandbox image', () => {
    expect(toolNameForSandboxRunner('Read')).toBe('read_file');
    expect(toolNameForSandboxRunner('Write')).toBe('write_file');
    expect(toolNameForSandboxRunner('List')).toBe('list_files');
    expect(toolNameForSandboxRunner('Shell')).toBe('run_shell');
  });

  it('does not rewrite tools already supported by both current and deployed sandbox runners', () => {
    expect(toolNameForSandboxRunner('Edit')).toBe('Edit');
    expect(toolNameForSandboxRunner('Glob')).toBe('Glob');
    expect(toolNameForSandboxRunner('Grep')).toBe('Grep');
    expect(toolNameForSandboxRunner('CreateArtifact')).toBe('CreateArtifact');
    expect(toolNameForSandboxRunner('WaitForWorkspaceReady')).toBe('WaitForWorkspaceReady');
  });
});
