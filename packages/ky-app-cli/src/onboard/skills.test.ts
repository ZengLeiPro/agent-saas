import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Manifest } from '@kaiyan/ky-app-contract';

import { installManifestSkills } from './skills.js';

let projectDir = '';
const document = '---\nname: demo-skill\ndescription: demo\n---\n正文\n';
const manifest = {
  contractVersion: 1,
  systemId: 'demo',
  name: 'Demo',
  description: 'Demo',
  icon: 'app',
  capabilities: [],
  events: [],
  skills: [{ id: 'demo-skill', path: 'skills/demo-skill/SKILL.md' }],
} as unknown as Manifest;

function contentDigest(): string {
  const data = Buffer.from(document);
  return createHash('sha256')
    .update('SKILL.md')
    .update('\0')
    .update(String(data.length))
    .update('\0')
    .update(data)
    .digest('hex');
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ky-app-skills-'));
  await mkdir(join(projectDir, 'skills/demo-skill'), { recursive: true });
  await writeFile(join(projectDir, 'skills/demo-skill/SKILL.md'), document, 'utf8');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(projectDir, { recursive: true, force: true });
});

describe('installManifestSkills', () => {
  it('已有技能只有内容摘要一致才按幂等成功处理', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ version: { definition: { contentDigest: contentDigest() } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      installManifestSkills({
        baseUrl: 'https://agent.example.com',
        token: 'secret',
        tenantId: 'tenant-a',
        projectDir,
        manifest,
      }),
    ).resolves.toEqual({ installed: [], existing: ['demo-skill'] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('已有技能内容漂移时 fail closed，不静默沿用旧版本', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ version: { definition: { contentDigest: 'different' } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    );

    await expect(
      installManifestSkills({
        baseUrl: 'https://agent.example.com',
        token: 'secret',
        tenantId: 'tenant-a',
        projectDir,
        manifest,
      }),
    ).rejects.toThrow(/内容与当前项目不一致/u);
  });
});
