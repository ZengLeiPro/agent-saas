import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// altool in Xcode 26 may print ERROR and still exit 0 (fastlane/fastlane#29740).
// A zero exit is necessary, never sufficient. Keep stdout and stderr separate
// so interleaved diagnostics cannot corrupt a JSON response. Raw output stays
// private; only this module's bounded, allowlisted diagnostic is published.
export const UPLOAD_OUTPUT_LIMIT = 256 * 1024; // per stream, not a rolling tail
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const errorSignals = [
  ['TOOL_ERROR', /\bERROR\s*:/iu],
  ['UPLOAD_FAILED', /\b(?:UPLOAD FAILED|Failed to upload|Unable to upload)\b/iu],
  ['VALIDATION_FAILED', /\b(?:Validation failed|Unable to validate archive)\b/iu],
  ['STRUCTURED_ERRORS', /"(?:product-errors|errors)"\s*:\s*\[\s*[^\]\s]/iu],
];
const hints = [
  ['CHECK_IPA_FILE', /(?:unsupported|invalid|unrecognized) (?:file|archive|package)|(?:file|archive).{0,40}(?:not found|does not exist)|\/dev\/fd\/3/iu],
  ['CHECK_API_CREDENTIALS', /authentication failed|invalid (?:api key|issuer)|unable to (?:load|find).{0,40}(?:private key|AuthKey)|not authori[sz]ed/iu],
  ['CHECK_BUILD_NUMBER', /bundle version must be higher|already been used|already uploaded|duplicate.{0,30}(?:build|version)/iu],
  ['CHECK_XCODE_SDK', /unsupported (?:SDK|Xcode)|SDK.{0,40}not supported/iu],
  ['CHECK_SIGNING', /(?:certificate|provisioning profile).{0,40}(?:invalid|expired|revoked)/iu],
];
const successMessage = /^(?:No errors uploading\s+['"].+\.ipa['"]\.?|UPLOAD SUCCEEDED(?: with (?:no|0) errors)?[.!]?)$/iu;

function jsonDocuments(text) {
  const trimmed = text.trim();
  if (!trimmed) return { documents: [], malformed: false };
  try { return { documents: [JSON.parse(trimmed)], malformed: false }; } catch { /* mixed logs/JSON */ }
  const documents = [];
  let start = -1, depth = 0, quoted = false, escaped = false, malformed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) {
      // altool can emit log lines before a pretty-printed JSON object. Do not
      // interpret JSON embedded in a quoted log message as a success receipt.
      if (char === '{' && /^\s*$/u.test(text.slice(text.lastIndexOf('\n', index - 1) + 1, index))) {
        start = index; depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        try { documents.push(JSON.parse(text.slice(start, index + 1))); } catch { malformed = true; }
        start = -1;
        if (documents.length >= 32) return { documents, malformed: true };
      }
    }
  }
  return { documents, malformed: malformed || start >= 0 };
}

export class UploadOutput {
  constructor() {
    this.streams = Object.fromEntries(['stdout', 'stderr'].map((name) => [name, {
      chunks: [], size: 0, retained: 0, overlap: '', hash: createHash('sha256'),
    }]));
    this.flags = new Set();
    this.codes = new Set();
    this.hints = new Set();
  }

  scan(text) {
    for (const [name, pattern] of errorSignals) if (pattern.test(text)) this.flags.add(name);
    for (const [name, pattern] of hints) if (pattern.test(text)) this.hints.add(name);
    for (const code of text.match(/\bITMS-[0-9]{4,6}\b/gu) || []) {
      if (this.codes.size < 10) this.codes.add(code);
    }
  }

  consume(name, chunk) {
    const stream = this.streams[name];
    assert.ok(stream, 'Invalid upload output stream');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stream.hash.update(bytes);
    stream.size += bytes.length;
    const kept = bytes.subarray(0, Math.max(0, UPLOAD_OUTPUT_LIMIT - stream.retained));
    if (kept.length) { stream.chunks.push(Buffer.from(kept)); stream.retained += kept.length; }
    // Sticky error flags survive truncation and arbitrary stdout/stderr chunks.
    const text = stream.overlap + bytes.toString('utf8');
    this.scan(text);
    stream.overlap = text.slice(-1024);
  }

  finish(exitCode, signal = null) {
    const formats = new Set();
    const deliveryIds = new Set();
    let malformed = false;
    let oversized = false;
    const sizes = {};
    const digests = {};
    const visitErrors = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 24) return;
      for (const [key, item] of Object.entries(value)) {
        if (['product-errors', 'errors', 'error'].includes(key) && item != null && item !== false && item !== '' && !(Array.isArray(item) && item.length === 0)) {
          this.flags.add('STRUCTURED_ERRORS');
        }
        if ((key === 'success' && item === false) || (key === 'status' && ['failed', 'failure', 'error'].includes(String(item).toLowerCase()))) this.flags.add('STRUCTURED_ERRORS');
        if (key === 'code' && this.codes.size < 10) {
          if (Number.isSafeInteger(item) && item !== 0 && Math.abs(item) <= 999999) this.codes.add(String(item));
          if (typeof item === 'string' && /^(?:ITMS-[0-9]{4,6}|STATE_ERROR\.VALIDATION_ERROR)$/u.test(item)) this.codes.add(item);
        }
        visitErrors(item, depth + 1);
      }
    };
    for (const [name, stream] of Object.entries(this.streams)) {
      sizes[`${name}Bytes`] = stream.size;
      digests[`${name}Sha256`] = stream.hash.digest('hex');
      oversized ||= stream.size > UPLOAD_OUTPUT_LIMIT;
      const text = Buffer.concat(stream.chunks).toString('utf8').replace(/^\uFEFF/u, '');
      const parsed = jsonDocuments(text);
      malformed ||= parsed.malformed;
      for (const document of parsed.documents) {
        visitErrors(document);
        if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
        if (typeof document['success-message'] === 'string' && successMessage.test(document['success-message'])) formats.add('altool-json');
        for (const key of ['delivery-id', 'delivery-uuid']) {
          if (typeof document[key] === 'string' && UUID.test(document[key])) deliveryIds.add(document[key].toLowerCase());
        }
      }
      // Xcode may emit the upload banner even when JSON was requested. Error
      // signals on EITHER stream always take precedence over this evidence.
      if (/^\s*UPLOAD SUCCEEDED(?: with (?:no|0) errors)?[.!]?\s*$/imu.test(text)) formats.add('altool-banner');
      for (const match of text.matchAll(/\bDelivery UUID:\s*([0-9a-f-]{36})\b/giu)) {
        if (UUID.test(match[1])) deliveryIds.add(match[1].toLowerCase());
      }
      stream.chunks = []; stream.overlap = '';
    }
    const reason = exitCode !== 0 || signal ? 'PROCESS_EXIT_ERROR'
      : this.flags.size ? 'TOOL_REPORTED_ERROR'
      : oversized ? 'OUTPUT_LIMIT_EXCEEDED'
      : malformed ? 'MALFORMED_OUTPUT'
      : formats.size === 0 ? 'NO_SUCCESS_EVIDENCE'
      : deliveryIds.size > 1 ? 'AMBIGUOUS_RECEIPT'
      : 'UPLOAD_REPORTED_SUCCESS';
    return Object.freeze({
      schemaVersion: 1, accepted: reason === 'UPLOAD_REPORTED_SUCCESS', reason,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: typeof signal === 'string' && /^SIG[A-Z0-9]{1,12}$/u.test(signal) ? signal : null,
      evidence: [...formats].sort(), errorSignals: [...this.flags].sort(),
      errorCodes: [...this.codes].sort(), hints: [...this.hints].sort(),
      deliveryId: deliveryIds.size === 1 ? [...deliveryIds][0] : null,
      ...sizes, ...digests,
    });
  }
}

export class UploadResultError extends Error {
  constructor(diagnostic) {
    super(`Apple upload not confirmed (exit=${diagnostic.exitCode}, reason=${diagnostic.reason}, codes=${diagnostic.errorCodes.join(',') || 'none'}, hints=${diagnostic.hints.join(',') || 'CHECK_UPLOAD_DIAGNOSTIC'}). See the upload diagnostic in this Actions log/summary; an Apple web error record may not exist.`);
    this.diagnostic = diagnostic;
  }
}
