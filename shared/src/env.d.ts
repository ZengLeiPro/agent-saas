/**
 * Ambient type declarations for universal APIs available in both Web and React Native.
 * These are NOT browser-specific — they exist in all JS runtimes we target.
 */

// Timer APIs
declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): ReturnType<typeof globalThis.setTimeout>;
declare function clearTimeout(id: ReturnType<typeof setTimeout> | undefined): void;
declare function setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): ReturnType<typeof globalThis.setInterval>;
declare function clearInterval(id: ReturnType<typeof setInterval> | undefined): void;

// Console
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
};

// Fetch API (available in Web, RN, and Node 18+)
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callbackfn: (value: string, key: string, parent: Headers) => void): void;
}
declare const Headers: {
  new(init?: HeadersInit): Headers;
};
type HeadersInit = Headers | Record<string, string> | [string, string][];

interface RequestInit {
  body?: BodyInit | null;
  headers?: HeadersInit;
  method?: string;
  signal?: AbortSignal | null;
  [key: string]: unknown;
}

type RequestInfo = string | Request;

interface Request {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  clone(): Response;
}

type BodyInit = string | Blob | ArrayBuffer | FormData | URLSearchParams | ReadableStream<Uint8Array>;

interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
}

interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void;
  delete(name: string): void;
  get(name: string): FormDataEntryValue | null;
  has(name: string): boolean;
  set(name: string, value: string | Blob, fileName?: string): void;
}
type FormDataEntryValue = string | File;
interface File extends Blob {
  readonly name: string;
  readonly lastModified: number;
}

interface URL {
  readonly href: string;
  readonly origin: string;
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  toString(): string;
}

interface URLSearchParams {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  toString(): string;
}

// WebSocket API (available in Web and RN)
interface WebSocket {
  readonly readyState: number;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer | Blob): void;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}
declare const WebSocket: {
  new(url: string, protocols?: string | string[]): WebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
};

interface Event {
  readonly type: string;
}

interface CloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

interface MessageEvent<T = unknown> extends Event {
  readonly data: T;
}

// AbortController / AbortSignal
interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

// ReadableStream (minimal)
interface ReadableStream<R = unknown> {
  readonly locked: boolean;
  getReader(): ReadableStreamDefaultReader<R>;
}
interface ReadableStreamDefaultReader<R = unknown> {
  read(): Promise<{ done: boolean; value: R | undefined }>;
  releaseLock(): void;
}

// JSON (already in ES2020 but needed for clarity)
declare function encodeURIComponent(uriComponent: string | number | boolean): string;
