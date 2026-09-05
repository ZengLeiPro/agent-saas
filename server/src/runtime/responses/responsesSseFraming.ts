import type { FinishedOutcome } from '../responsesAttemptDiagnostics.js';

export class ResponsesStreamError extends Error {
  constructor(
    readonly outcome: FinishedOutcome,
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ResponsesStreamError';
  }
}

export class SseFrameBuffer {
  private buffer = '';

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const blocks: string[] = [];
    while (true) {
      const boundary = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) break;
      const block = this.buffer.slice(0, boundary.index);
      if (Buffer.byteLength(block, 'utf8') > this.maxBytes) {
        throw new ResponsesStreamError(
          'parse_error',
          'MODEL_SSE_FRAME_TOO_LARGE',
          `Responses SSE frame exceeded ${this.maxBytes} bytes`,
        );
      }
      blocks.push(block);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) {
      throw new ResponsesStreamError(
        'parse_error',
        'MODEL_SSE_FRAME_TOO_LARGE',
        `Responses SSE frame exceeded ${this.maxBytes} bytes`,
      );
    }
    return blocks;
  }

  finish(): string {
    const tail = this.buffer;
    this.buffer = '';
    return tail;
  }
}
