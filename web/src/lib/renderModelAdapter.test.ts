import { describe, expect, it } from 'vitest';
import { selectRenderModel } from '@agent/shared';
import { adaptRenderModelForMobile } from '../../../mobile/src/lib/renderModelAdapter';
import { adaptRenderModelForWeb } from './renderModelAdapter';

describe('M50-01 Web/Mobile RenderModel adapters', () => {
  it('retain identical semantics and stable keys while mapping platform accessibility vocabulary', () => {
    const model = selectRenderModel({ messages: [
      { id: 'u', type: 'user', content: 'hello', status: 'sent' },
      { id: 't', type: 'tool_use', runId: 'r', toolId: 'call', toolName: 'Read', toolInput: '{}', executionStatus: 'running' },
      { id: 'e', type: 'system-error', runId: 'r2', content: 'token=ERROR_SECRET /workspace/private/error.log' },
    ] });
    const web = adaptRenderModelForWeb(model);
    const mobile = adaptRenderModelForMobile(model);
    expect(web.map((row) => row.key)).toEqual(mobile.map((row) => row.key));
    expect(web.map((row) => row.semantic)).toEqual(mobile.map((row) => row.semantic));
    expect(web[2].accessibility).toMatchObject({ role: 'alert', live: 'assertive' });
    expect(mobile[2].accessibility).toMatchObject({ role: 'alert', live: 'assertive' });
    expect(web[1].presentation?.presentation.status).toBe('running');
    expect(web[2].presentation?.presentation.status).toBe('failed');
    expect(mobile[2].presentation?.presentation.busy).toBe(false);
    const semanticTrees = JSON.stringify({
      web: web.map((row) => ({ semantic: row.semantic, accessibility: row.accessibility })),
      mobile: mobile.map((row) => ({ semantic: row.semantic, accessibility: row.accessibility })),
    });
    expect(semanticTrees).not.toContain('ERROR_SECRET');
    expect(semanticTrees).not.toContain('/workspace');
  });
});
