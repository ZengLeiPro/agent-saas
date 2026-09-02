import { describe, expect, it } from 'vitest';
import { assertNoLocalAttachmentReference, createAttachmentUploadIntent, reduceAttachmentUpload } from '@agent/shared';
import { AttachmentPickerAdapter } from './attachmentPickerAdapter';

describe('M50-03 Mobile in-memory picker boundary', () => {
  it('keeps URI only in the adapter and fences it on lock/offline/identity switch', () => {
    const adapter = new AttachmentPickerAdapter();
    adapter.select('intent-1', { uri: 'file:///private/photo.png', name: 'photo.png', mimeType: 'image/png', size: 8 });
    expect(adapter.read('intent-1').uri).toBe('file:///private/photo.png');
    const shared = createAttachmentUploadIntent({
      localIntentId: 'intent-1', uploadRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'photo.png', mimeType: 'image/png', size: 8,
    });
    expect(() => assertNoLocalAttachmentReference(shared)).not.toThrow();
    expect(JSON.stringify(shared)).not.toContain('file:');
    for (const reason of ['offline', 'locked', 'identity_boundary'] as const) {
      expect(reduceAttachmentUpload(shared, { type: 'fence', reason })).toMatchObject({ status: 'cancelled', requiresReselection: true });
    }
    adapter.fence();
    expect(adapter.size).toBe(0);
    expect(() => adapter.read('intent-1')).toThrow('重新选择');
  });
});
