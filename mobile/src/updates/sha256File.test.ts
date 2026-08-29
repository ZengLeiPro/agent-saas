import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: vi.fn(),
}));

import { sha256File } from './sha256File';

describe('M10-04 incremental APK SHA-256', () => {
  it('hashes every binary chunk instead of trusting file size', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const reader = vi.fn(async (_uri: string, options: { position: number; length: number }) =>
      bytes.subarray(options.position, options.position + options.length).toString('base64'),
    );

    await expect(sha256File('file:///synthetic.apk', bytes.length, reader as any)).resolves.toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(reader.mock.calls.length).toBeGreaterThan(1);
  });

  it('fails closed when a native file read returns fewer bytes than requested', async () => {
    const reader = vi.fn(async () => Buffer.from('short').toString('base64'));
    await expect(sha256File('file:///truncated.apk', 100, reader as any)).rejects.toThrow(
      /read length mismatch/,
    );
  });
});
