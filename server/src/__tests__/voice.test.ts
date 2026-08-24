import type { Server } from 'node:http';
import { Readable, Writable } from 'node:stream';
import express, { type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openTrustedFile: vi.fn(),
}));

vi.mock('../security/trustedFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/trustedFile.js')>();
  return { ...actual, openTrustedFile: mocks.openTrustedFile };
});

import { createVoiceRouter } from '../routes/voice.js';

interface FakeHandle {
  close: ReturnType<typeof vi.fn>;
  createReadStream: ReturnType<typeof vi.fn>;
}

const servers: Server[] = [];

function fakeOpened(size: number, createReadStream: FakeHandle['createReadStream'] = vi.fn(() => Readable.from('audio'))) {
  const handle: FakeHandle = {
    close: vi.fn(async () => undefined),
    createReadStream,
  };
  return {
    opened: { handle, stats: { size }, fdPath: '/proc/self/fd/test' },
    handle,
  };
}

async function startServer(): Promise<{ baseUrl: string }> {
  const app = express();
  app.use(createVoiceRouter({ agentCwd: '/tmp/voice-test-workspace' }));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Voice test server did not bind a TCP port');
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

beforeEach(() => {
  mocks.openTrustedFile.mockReset();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('voice range streaming', () => {
  it.each([
    'bytes=abc-',
    'bytes=9007199254740992-',
    'bytes=0-9007199254740992',
    'bytes=0-1,3-4',
    'bytes=-1',
    'bytes=0',
    'items=0-1',
  ])('rejects malformed or unsafe Range %s and closes its handle', async (range) => {
    const handles: FakeHandle[] = [];
    mocks.openTrustedFile.mockImplementation(async () => {
      const result = fakeOpened(5);
      handles.push(result.handle);
      return result.opened;
    });
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/voice/play?path=audio.wav`, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */5');
    await response.arrayBuffer();
    expect(handles).toHaveLength(1);
    expect(handles[0]!.createReadStream).not.toHaveBeenCalled();
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a Range on an empty file and closes its handle', async () => {
    const { opened, handle } = fakeOpened(0);
    mocks.openTrustedFile.mockResolvedValue(opened);
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/voice/play?path=empty.wav`, { headers: { Range: 'bytes=0-' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */0');
    await response.arrayBuffer();
    expect(handle.createReadStream).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('streams a valid Range and explicitly closes the descriptor after completion', async () => {
    const createReadStream = vi.fn(() => Readable.from('bc'));
    const { opened, handle } = fakeOpened(5, createReadStream);
    mocks.openTrustedFile.mockResolvedValue(opened);
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/voice/play?path=audio.wav`, { headers: { Range: 'bytes=1-2' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('bc');
    expect(createReadStream).toHaveBeenCalledWith({ start: 1, end: 2, autoClose: false });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('closes the handle when createReadStream throws', async () => {
    const createReadStream = vi.fn(() => {
      throw new Error('createReadStream failed');
    });
    const { opened, handle } = fakeOpened(5, createReadStream);
    mocks.openTrustedFile.mockResolvedValue(opened);
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/voice/play?path=audio.wav`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to stream audio file' });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('closes the handle when the response stream fails', async () => {
    class FailingResponse extends Writable {
      headersSent = false;
      statusCode = 200;

      status(code: number): this {
        this.statusCode = code;
        return this;
      }

      setHeader(): this {
        return this;
      }

      _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.headersSent = true;
        callback(new Error('response failed'));
      }
    }

    const { opened, handle } = fakeOpened(5, vi.fn(() => Readable.from('audio')));
    mocks.openTrustedFile.mockResolvedValue(opened);
    const router = createVoiceRouter({ agentCwd: '/tmp/voice-test-workspace' });
    const handler = (router as any).stack[0].route.stack[0].handle as (req: Request, res: Response) => Promise<void>;
    const request = { query: { path: 'audio.wav' }, headers: {} } as unknown as Request;
    const response = new FailingResponse() as unknown as Response;

    await handler(request, response);

    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
