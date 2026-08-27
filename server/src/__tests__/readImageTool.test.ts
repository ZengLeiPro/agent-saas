import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PlatformToolRuntime,
  type WorkspaceRef,
} from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

function workspace(root: string): WorkspaceRef {
  return {
    root,
    userId: 'admin-1',
    username: 'admin',
    sessionId: 'session-1',
    executionTarget: 'server-local',
  };
}

const channelContext = {
  channel: 'web' as const,
  user: {
    id: 'admin-1',
    username: 'admin',
    role: 'admin' as const,
    tenantId: DEFAULT_TENANT_ID,
  },
};

describe('Read 图片工具', () => {
  it('将图片规范化为模型视觉输入，而不是按 UTF-8 文本返回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-read-image-'));
    try {
      await copyFile(join(process.cwd(), '../web/public/favicon-32x32.png'), join(root, '界面.png'));
      const result = await new PlatformToolRuntime().invoke({
        toolId: 'Read',
        input: { path: '界面.png' },
        authorization: { approved: true, source: 'policy_auto' },
      }, { channelContext, workspace: workspace(root) });

      expect(result.content).toContain('Read image 界面.png');
      expect(result.content).not.toContain('\uFFFD');
      expect(result.modelImages).toHaveLength(1);
      expect(result.modelImages?.[0]).toMatchObject({
        type: 'image_attachment',
        displayName: '界面.png',
        mimeType: 'image/png',
        width: 32,
        height: 32,
      });
      expect(result.modelImages?.[0]?.relativePath).toMatch(/^uploads\/\.model-images\/[a-f0-9]{64}-v1\.png$/);
      expect(await readFile(join(root, result.modelImages![0]!.relativePath))).not.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('忽略图片调用中的文本行范围参数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-read-image-range-'));
    try {
      await copyFile(join(process.cwd(), '../web/public/favicon-32x32.png'), join(root, '界面.png'));
      const result = await new PlatformToolRuntime().invoke({
        toolId: 'Read',
        input: { path: '界面.png', offset: 1, limit: 10 },
        authorization: { approved: true, source: 'policy_auto' },
      }, { channelContext, workspace: workspace(root) });

      expect(result.content).toContain('Read image 界面.png');
      expect(result.modelImages).toHaveLength(1);
      expect(result.modelImages?.[0]).toMatchObject({
        type: 'image_attachment',
        displayName: '界面.png',
        mimeType: 'image/png',
        width: 32,
        height: 32,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
