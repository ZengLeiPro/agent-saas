import type { Request, Response } from 'express';

import type { TrustedFile } from '../security/trustedFile.js';

export async function sendTaskAttachment(req: Request, res: Response, file: TrustedFile): Promise<void> {
  const size = file.stats.size;
  let start: number | undefined;
  let end: number | undefined;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      await file.handle.close();
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || start >= size) {
      await file.handle.close();
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', start === undefined ? size : end! - start + 1);
  await new Promise<void>((resolve, reject) => {
    const stream = file.handle.createReadStream({
      ...(start === undefined ? {} : { start, end }),
      autoClose: true,
    });
    stream.once('error', reject);
    res.once('error', reject);
    res.once('finish', resolve);
    res.once('close', resolve);
    stream.pipe(res);
  });
}
