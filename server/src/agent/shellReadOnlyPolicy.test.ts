import { describe, expect, it } from 'vitest';

import { DefaultToolPolicy } from '../runtime/toolPolicy.js';
import type { RunContext } from '../runtime/types.js';
import { runShellToolDescriptor } from './toolRuntime.js';
import { isProvablyReadOnlyShellCommand } from './shellReadOnlyPolicy.js';

const context = {
  channelContext: {
    channel: 'web',
    user: { id: 'user-1', username: 'tester', role: 'user' },
  },
} as RunContext;

describe('read-only Shell call policy', () => {
  it.each([
    'rg --no-config --files',
    "rg --no-config -n 'price$|a;b' .",
    "rg --no-config -n price -g 'server/src/**' .",
    "rg --no-config --files -g '*.ts' .",
    'rg --no-config -n -e needle .',
    'rg --no-config --line-number "plain text" .',
  ])('allows a provably read-only direct rg command: %s', async (command) => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
    await expect(
      new DefaultToolPolicy().decide(runShellToolDescriptor, { command }, context),
    ).resolves.toEqual({ type: 'allow' });
  });

  it.each([
    'rg --files',
    'rg --no-config -n pattern',
    'rg --no-config -n pattern | head',
    'rg --no-config -n pattern > result.txt',
    'rg --no-config -n $(touch owned)',
    'rg --no-config -n `touch owned`',
    'rg --no-config -n "$(touch owned)"',
    'rg --no-config -n "`touch owned`"',
    'rg --no-config -n pattern $FILES',
    'rg --no-config -n pattern *',
    'rg --no-config -a -n TOKEN /proc/self/environ',
    'rg --no-config -n pattern ../outside',
    "rg --no-config -n '^root:' leak",
    'rg --no-config --files leak',
    'rg -n -e --no-config .',
    'rg --no-config -n pattern server/src',
    'rg --no-config -n pattern .git/config',
    'rg --no-config --files .git',
    'rg --no-config -n pattern node_modules',
    'rg --no-config -n --hidden pattern .',
    'rg --no-config -nu pattern .',
    'rg --no-config -nL pattern link',
    'rg --no-config -n -f patterns.txt .',
    'rg --no-config -n pattern\ntouch owned',
    'rg --no-config -n pattern; touch owned',
    'rg --no-config -n pattern --pre=touch',
    'rg --no-config -zn pattern',
    'find . -type f',
    "rg --no-config -n 'unterminated",
  ])('keeps ambiguous or executable shell syntax dangerous: %s', async (command) => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    await expect(
      new DefaultToolPolicy().decide(runShellToolDescriptor, { command }, context),
    ).resolves.toMatchObject({ type: 'requires_approval' });
  });
});
