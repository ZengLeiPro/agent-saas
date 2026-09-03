import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectUploadedFile, UploadPolicyError } from '../uploads/uploadSecurity.js';

const ZIP_TEXT =
  'UEsDBBQAAAAAAAAAAACGphA2BQAAAAUAAAAJAAAAbm90ZXMudHh0aGVsbG9QSwECFAAUAAAAAAAAAAAAhqYQNgUAAAAFAAAACQAAAAAAAAAAAAAAAAAAAAAAbm90ZXMudHh0UEsFBgAAAAABAAEANwAAACwAAAAAAA==';
const ZIP_HTML =
  'UEsDBBQAAAAAAAAAAADnKPn2DQAAAA0AAAAOAAAAd2ViL2luZGV4Lmh0bWw8aDE+RGVtbzwvaDE+UEsBAhQAFAAAAAAAAAAAAOco+fYNAAAADQAAAA4AAAAAAAAAAAAAAAAAAAAAAHdlYi9pbmRleC5odG1sUEsFBgAAAAABAAEAPAAAADkAAAAAAA==';
const ZIP_UNSAFE_PATH =
  'UEsDBBQAAAAAAAAAAABdm7CPAgAAAAIAAAALAAAALi4vZXZpbC5leGVNWlBLAQIUABQAAAAAAAAAAABdm7CPAgAAAAIAAAALAAAAAAAAAAAAAAAAAAAAAAAuLi9ldmlsLmV4ZVBLBQYAAAAAAQABADkAAAArAAAAAAA=';

describe('permissive attachment upload security', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function inspect(name: string, mimetype: string, bytes: string | Buffer) {
    const root = await mkdtemp(join(tmpdir(), 'upload-security-'));
    roots.push(root);
    const path = join(root, 'upload');
    const content = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    await writeFile(path, content);
    return inspectUploadedFile({ path, originalName: name, size: content.length, mimetype });
  }

  it.each([
    ['文档 V2.5.pdf', 'application/pdf', '%PDF-1.7\nvalid', 'application/pdf'],
    ['Demo-V2.7 (1).html', 'text/html', '<!doctype html><h1>Demo</h1>', 'text/html'],
    ['Demo.html', 'text/html', '<h1>Demo</h1>', 'text/html'],
    ['Demo-without-client-mime.html', '', '<h1>Demo</h1>', 'text/html'],
    [
      'install.exe',
      'application/x-msdownload',
      Buffer.from([0x4d, 0x5a, 0, 0]),
      'application/octet-stream',
    ],
  ] as const)(
    'accepts %s and classifies it safely',
    async (name, mimetype, bytes, expectedMime) => {
      await expect(inspect(name, mimetype, bytes)).resolves.toMatchObject({
        mimeType: expectedMime,
      });
    },
  );

  it('downgrades MIME disguises to an opaque download instead of rejecting the upload', async () => {
    await expect(inspect('photo.png', 'image/png', 'not-a-png')).resolves.toMatchObject({
      mimeType: 'application/octet-stream',
      isImage: false,
      detectedMimeType: 'text/plain',
      contentMismatch: true,
    });
    await expect(
      inspect('photo.pdf.exe', 'application/pdf', Buffer.from([0x4d, 0x5a, 0, 0])),
    ).resolves.toMatchObject({
      mimeType: 'application/octet-stream',
      isImage: false,
      contentMismatch: true,
      activeContent: true,
    });
  });

  it('classifies a multi-dot filename by its actual content instead of the number of dots', async () => {
    await expect(
      inspect('invoice.pdf.exe', 'application/pdf', '%PDF-1.7\nvalid'),
    ).resolves.toMatchObject({
      mimeType: 'application/pdf',
      isImage: false,
      contentMismatch: false,
      activeContent: false,
    });
  });

  it('accepts ordinary ZIP and ZIP containing HTML as inert archives', async () => {
    await expect(
      inspect('ordinary.zip', 'application/zip', Buffer.from(ZIP_TEXT, 'base64')),
    ).resolves.toMatchObject({
      mimeType: 'application/zip',
      archive: { entryCount: 1, containsActiveContent: false, containsExecutable: false },
    });
    await expect(
      inspect('Demo.html.zip', 'application/zip', Buffer.from(ZIP_HTML, 'base64')),
    ).resolves.toMatchObject({
      mimeType: 'application/zip',
      archive: { entryCount: 1, containsActiveContent: true, containsExecutable: false },
    });
  });

  it('rejects damaged ZIP and unsafe archive paths with accurate codes', async () => {
    await expect(
      inspect('broken.zip', 'application/zip', Buffer.from('PK\x03\x04broken', 'binary')),
    ).rejects.toMatchObject({
      code: 'UPLOAD_ARCHIVE_INVALID',
    } satisfies Partial<UploadPolicyError>);
    await expect(
      inspect('unsafe.zip', 'application/zip', Buffer.from(ZIP_UNSAFE_PATH, 'base64')),
    ).rejects.toMatchObject({ code: 'UPLOAD_ARCHIVE_UNSAFE' } satisfies Partial<UploadPolicyError>);
  });
});
