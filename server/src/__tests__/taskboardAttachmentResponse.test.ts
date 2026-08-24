import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sendTaskAttachment } from '../routes/taskboardAttachmentResponse.js';
import { openTrustedFile } from '../security/trustedFile.js';

let root = '';
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'taskboard-range-'));
  await writeFile(join(root, 'data.txt'), 'taskboard payload');
  await writeFile(join(root, 'empty.txt'), '');

  const app = express();
  app.get('/:name', async (req, res, next) => {
    try {
      const file = await openTrustedFile(root, req.params.name);
      await sendTaskAttachment(req, res, file);
    } catch (error) {
      next(error);
    }
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('sendTaskAttachment byte ranges', () => {
  it('clamps an otherwise valid explicit end to EOF and keeps 206', async () => {
    const response = await fetch(`${baseUrl}/data.txt`, { headers: { Range: 'bytes=0-1000' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-16/17');
    expect(response.headers.get('content-length')).toBe('17');
    expect(await response.text()).toBe('taskboard payload');
  });

  it.each(['bytes=-0', 'bytes=--1'])('rejects zero or negative suffix %s', async (range) => {
    const response = await fetch(`${baseUrl}/data.txt`, { headers: { Range: range } });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */17');
  });

  it('rejects every range for an empty file', async () => {
    const response = await fetch(`${baseUrl}/empty.txt`, { headers: { Range: 'bytes=0-1000' } });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */0');
  });

  it.each(['bytes=8-4', 'bytes=0-1,4-5', 'items=0-1'])(
    'rejects invalid or unsupported range %s',
    async (range) => {
      const response = await fetch(`${baseUrl}/data.txt`, { headers: { Range: range } });

      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */17');
    },
  );
});
