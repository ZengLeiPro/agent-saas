import {
  MAX_ARTIFACT_PAYLOAD_BYTES,
  MAX_READ_IMAGE_SOURCE_BYTES,
  WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY,
} from './workspaceHandTools.js';
import { MAX_FILE_BYTES, MAX_READ_LINES, MAX_READ_OUTPUT_BYTES } from './toolOutput.js';

export const MAX_CONTAINER_HELPER_OUTPUT =
  Math.ceil(Math.max(MAX_ARTIFACT_PAYLOAD_BYTES, MAX_READ_IMAGE_SOURCE_BYTES) * 1.4) + 64 * 1024;
export const DEFAULT_CONTAINER_WORKDIR = '/workspace';

const CONTAINER_EDIT_HELPER_SCRIPT = String.raw`
const editGraphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function editStripBom(content) {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}
function editDetectLineEnding(content) {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/\n/g) || []).length - crlfCount;
  if (crlfCount === 0) return '\n';
  if (crlfCount !== lfCount) return crlfCount > lfCount ? '\r\n' : '\n';
  const firstNewline = content.indexOf('\n');
  return firstNewline > 0 && content[firstNewline - 1] === '\r' ? '\r\n' : '\n';
}
function editNormalizeToLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function editRestoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
function editNormalizeFuzzy(text) {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}
function editNormalizeCodePoint(value) {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}
function editAppendMappedSegment(segment, segmentOffset, output, starts, ends) {
  const units = [];
  for (const grapheme of editGraphemeSegmenter.segment(segment)) {
    const start = segmentOffset + grapheme.index;
    const end = start + grapheme.segment.length;
    const normalized = editNormalizeCodePoint(grapheme.segment);
    for (let i = 0; i < normalized.length; i++) {
      units.push({ value: normalized[i], start, end });
    }
  }
  while (units.length > 0 && /\s/u.test(units[units.length - 1].value)) units.pop();
  for (const unit of units) {
    output.push(unit.value);
    starts.push(unit.start);
    ends.push(unit.end);
  }
}
function editCreateFuzzyView(content) {
  const output = [];
  const starts = [];
  const ends = [];
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    editAppendMappedSegment(content.slice(lineStart, lineEnd), lineStart, output, starts, ends);
    if (newline === -1) break;
    output.push('\n');
    starts.push(newline);
    ends.push(newline + 1);
    lineStart = newline + 1;
  }
  return { text: output.join(''), starts, ends };
}
function editCreateLineEndingView(content) {
  const output = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\r') {
      const end = content[i + 1] === '\n' ? i + 2 : i + 1;
      output.push('\n');
      starts.push(i);
      ends.push(end);
      if (end === i + 2) i++;
      continue;
    }
    output.push(content[i]);
    starts.push(i);
    ends.push(i + 1);
  }
  return { text: output.join(''), starts, ends };
}
function editMapViewRanges(view, ranges) {
  return ranges.map((range) => ({
    start: view.starts[range.start],
    end: view.ends[range.end - 1]
  }));
}
function editFindAllRanges(content, needle) {
  if (needle.length === 0) return [];
  const ranges = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const start = content.indexOf(needle, from);
    if (start === -1) break;
    ranges.push({ start, end: start + needle.length });
    if (ranges.length > maxEditReplacements) {
      throw new Error('Edit: match count exceeds ' + maxEditReplacements + '; use Write or Shell for a bulk rewrite.');
    }
    from = start + needle.length;
  }
  return ranges;
}
function editFuzzyRanges(view, oldText) {
  const fuzzyOldText = editNormalizeFuzzy(oldText);
  if (fuzzyOldText.length === 0) return [];
  return editFindAllRanges(view.text, fuzzyOldText)
    .filter((range) => {
      const startsInsideMappedUnit = range.start > 0 && view.starts[range.start] === view.starts[range.start - 1];
      const endsInsideMappedUnit = range.end < view.text.length && view.ends[range.end - 1] === view.ends[range.end];
      return !startsInsideMappedUnit && !endsInsideMappedUnit;
    })
    .map((range) => ({
      start: view.starts[range.start],
      end: view.ends[range.end - 1]
    }));
}
function editCollectOperations(request) {
  const operations = [];
  const hasLegacy = request.old_string !== undefined || request.new_string !== undefined;
  if (hasLegacy) {
    if (typeof request.old_string !== 'string' || typeof request.new_string !== 'string') {
      throw new Error('Edit: legacy input requires string old_string and new_string.');
    }
    operations.push({
      old_string: request.old_string,
      new_string: request.new_string,
      replace_all: request.replace_all
    });
  }
  if (Array.isArray(request.edits)) operations.push(...request.edits);
  if (operations.length === 0) throw new Error('Edit: at least one edit is required.');
  return operations;
}
function editApplyOperations(content, operations, relPath) {
  const stripped = editStripBom(content);
  const lineEnding = editDetectLineEnding(stripped.text);
  const lineEndingView = editCreateLineEndingView(stripped.text);
  const fuzzyView = editCreateFuzzyView(lineEndingView.text);
  const planned = [];
  let occurrences = 0;
  let fuzzyMatches = 0;
  operations.forEach((operation, editIndex) => {
    if (!operation || typeof operation.old_string !== 'string' || typeof operation.new_string !== 'string') {
      throw new Error('Edit: edits[' + editIndex + '] requires string old_string and new_string.');
    }
    const oldIncludesBom = operation.old_string.startsWith('\uFEFF');
    const oldText = editNormalizeToLf(oldIncludesBom ? operation.old_string.slice(1) : operation.old_string);
    const newText = editRestoreLineEndings(editNormalizeToLf(operation.new_string), lineEnding);
    const label = operations.length === 1 ? 'old_string' : 'edits[' + editIndex + '].old_string';
    if (oldText.length === 0) throw new Error('Edit: ' + label + ' is empty; use Write for new files.');
    if (oldText === newText) throw new Error('Edit: ' + label + ' equals new_string; no-op.');
    let fuzzy = false;
    let viewRanges = editFindAllRanges(lineEndingView.text, oldText);
    if (viewRanges.length === 0) {
      fuzzy = true;
      viewRanges = editFuzzyRanges(fuzzyView, oldText);
    }
    if (oldIncludesBom) {
      viewRanges = stripped.bom ? viewRanges.filter((range) => range.start === 0) : [];
    }
    if (viewRanges.length === 0) {
      throw new Error('Edit: ' + label + ' not found. It must match including whitespace and newlines; fuzzy quote/space normalization also found no match.');
    }
    if (!operation.replace_all && viewRanges.length > 1) {
      throw new Error('Edit: ' + label + ' matched ' + viewRanges.length + ' times; supply more surrounding context or set replace_all=true.');
    }
    occurrences += viewRanges.length;
    const selectedViewRanges = operation.replace_all ? viewRanges : viewRanges.slice(0, 1);
    const selected = editMapViewRanges(lineEndingView, selectedViewRanges);
    if (planned.length + selected.length > maxEditReplacements) {
      throw new Error('Edit: total replacement count exceeds ' + maxEditReplacements + '; split the operation or use Write/Shell.');
    }
    if (fuzzy) fuzzyMatches += selected.length;
    for (const range of selected) {
      const replacementText = stripped.bom && range.start === 0 && newText.startsWith('\uFEFF')
        ? newText.slice(1)
        : newText;
      planned.push({ editIndex, start: range.start, end: range.end, newText: replacementText });
    }
  });
  planned.sort((a, b) => a.start - b.start || a.end - b.end || a.editIndex - b.editIndex);
  for (let i = 1; i < planned.length; i++) {
    const previous = planned[i - 1];
    const current = planned[i];
    if (previous.end > current.start) {
      throw new Error('Edit: edits[' + previous.editIndex + '] and edits[' + current.editIndex + '] overlap in ' + relPath + '; merge them into one edit or target disjoint regions.');
    }
  }
  const chunks = [];
  let cursor = 0;
  for (const replacement of planned) {
    chunks.push(stripped.text.slice(cursor, replacement.start), replacement.newText);
    cursor = replacement.end;
  }
  chunks.push(stripped.text.slice(cursor));
  const updated = chunks.join('');
  if (updated === stripped.text) {
    throw new Error('Edit: no changes made to ' + relPath + '; the replacement produced identical content.');
  }
  const updatedContent = stripped.bom + updated;
  const updatedBytes = Buffer.byteLength(updatedContent, 'utf8');
  if (updatedBytes > maxEditFileBytes) {
    throw new Error('Edit: result too large (' + updatedBytes + 'B > ' + maxEditFileBytes + 'B); use Write for intentional full-file rewrites.');
  }
  return {
    updatedContent,
    replacements: planned.length,
    occurrences,
    editCount: operations.length,
    fuzzyMatches,
    bomPreserved: stripped.bom.length > 0,
    lineEnding: lineEnding === '\r\n' ? 'CRLF' : 'LF'
  };
}
`;

export const CONTAINER_FILE_HELPER_SCRIPT = `
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');
const root = process.env.KY_AGENT_WORKDIR || ${JSON.stringify(DEFAULT_CONTAINER_WORKDIR)};
const maxFileBytes = ${MAX_FILE_BYTES};
const maxReadLines = ${MAX_READ_LINES};
const maxReadOutputBytes = ${MAX_READ_OUTPUT_BYTES};
const maxEditFileBytes = 1000000;
const maxEditReplacements = 10000;
const maxContainerHelperOutputBytes = ${MAX_CONTAINER_HELPER_OUTPUT};
const maxArtifactPayloadBytes = ${MAX_ARTIFACT_PAYLOAD_BYTES};
const maxReadImageSourceBytes = ${MAX_READ_IMAGE_SOURCE_BYTES};
const readImagePayloadMetadataKey = ${JSON.stringify(WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY)};
const editDenyPatterns = [/(^|\\/)\\.ky-agent\\/settings\\.json$/i, /(^|\\/)\\.claude\\/settings\\.json$/i, /(^|\\/)\\.env(\\..+)?$/i, /(^|\\/)\\.npmrc$/i, /(^|\\/)\\.netrc$/i, /(^|\\/)\\.ssh\\//i, /(^|\\/)\\.git\\//i];
function isInside(baseDir, candidate) {
  const rel = path.relative(baseDir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function resolveWorkspacePath(inputPath) {
  const fullPath = path.resolve(root, inputPath || '.');
  if (!isInside(root, fullPath)) {
    throw new Error('Access denied: path outside workspace (' + inputPath + ')');
  }
  return fullPath;
}
function readPathVariants(inputPath) {
  const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
  const variants = new Set();
  const add = (value) => {
    variants.add(value);
    variants.add(value.normalize('NFC'));
    variants.add(value.normalize('NFD'));
    variants.add(value.replace(/'/g, '\u2019'));
    variants.add(value.replace(/\u2019/g, "'"));
    variants.add(value.replace(/ (AM|PM)\\./gi, '\u202F$1.'));
  };
  add(String(inputPath || ''));
  const withoutAtPrefix = String(inputPath || '').startsWith('@') ? String(inputPath).slice(1) : String(inputPath || '');
  add(withoutAtPrefix);
  add(withoutAtPrefix.replace(unicodeSpaces, ' '));
  return [...variants];
}
async function openTrustedParent(fullPath, operation, createParents) {
  const parentPath = path.dirname(fullPath);
  const relParent = path.relative(root, parentPath);
  if (relParent === '..' || relParent.startsWith('..' + path.sep) || path.isAbsolute(relParent)) {
    throw new Error(operation + ': parent escapes workspace');
  }
  const flags = fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW;
  let current = await fs.open(root, flags);
  try {
    for (const part of relParent.split(path.sep).filter(Boolean)) {
      const candidate = '/proc/self/fd/' + current.fd + '/' + part;
      let next;
      try {
        next = await fs.open(candidate, flags);
      } catch (error) {
        if (!createParents || !error || error.code !== 'ENOENT') {
          if (error && (error.code === 'ELOOP' || error.code === 'ENOTDIR')) {
            throw new Error(operation + ': refused symlink path ' + relativeWorkspacePath(path.join(parentPath, part)));
          }
          throw error;
        }
        await fs.mkdir(candidate).catch((mkdirError) => {
          if (!mkdirError || mkdirError.code !== 'EEXIST') throw mkdirError;
        });
        next = await fs.open(candidate, flags);
      }
      await current.close();
      current = next;
    }
    const parentFdPath = '/proc/self/fd/' + current.fd;
    const openedParent = await fs.realpath(parentFdPath);
    if (!isInside(root, openedParent)) throw new Error(operation + ': opened parent escapes workspace');
    return {
      directory: current,
      leaf: path.basename(fullPath),
      targetPath: path.join(parentFdPath, path.basename(fullPath))
    };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}
async function openTrustedExistingFile(fullPath, operation) {
  const binding = await openTrustedParent(fullPath, operation, false);
  let handle;
  try {
    handle = await fs.open(binding.targetPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(operation + ': path is not a file (' + relativeWorkspacePath(fullPath) + ')');
    const openedPath = await fs.realpath('/proc/self/fd/' + handle.fd);
    if (!isInside(root, openedPath)) throw new Error(operation + ': opened file escapes workspace');
    return {
      ...binding,
      handle,
      stats,
      fdPath: '/proc/self/fd/' + handle.fd,
      openedPath,
      relativePath: relativeWorkspacePath(openedPath)
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await binding.directory.close().catch(() => undefined);
    if (error && error.code === 'ELOOP') {
      throw new Error(operation + ': refused symlink path ' + relativeWorkspacePath(fullPath));
    }
    throw error;
  }
}
async function resolveReadPath(inputPath) {
  let exactError;
  for (const variant of readPathVariants(inputPath)) {
    const fullPath = resolveWorkspacePath(variant);
    try {
      return {
        ...(await openTrustedExistingFile(fullPath, 'Read')),
        recovered: variant !== inputPath
      };
    } catch (error) {
      if (!exactError) exactError = error;
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw exactError || new Error('Read: file not found (' + inputPath + ')');
}
async function assertNoSymlinkPath(fullPath, operation) {
  const relPath = path.relative(root, fullPath);
  let current = root;
  for (const part of relPath.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(operation + ': refused symlink path ' + relativeWorkspacePath(current));
    }
  }
}
function relativeWorkspacePath(fullPath) {
  return path.relative(root, fullPath) || '.';
}
function normalizePath(value) {
  return String(value || '').split(path.sep).join('/');
}
function assertNotDenied(relPath, patterns, message) {
  const normalized = normalizePath(relPath);
  for (const re of patterns) {
    if (re.test('/' + normalized)) throw new Error(message);
  }
}
async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
async function readFileBufferPrefix(fullPath, maxBytes) {
  const handle = await fs.open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}
async function readFilePrefix(fullPath, maxBytes) {
  return (await readFileBufferPrefix(fullPath, maxBytes)).toString('utf-8');
}
function quoteShellArgument(value) {
  const singleQuote = String.fromCharCode(39);
  const escapedQuote = singleQuote + String.fromCharCode(34) + singleQuote + String.fromCharCode(34) + singleQuote;
  return singleQuote + String(value).split(singleQuote).join(escapedQuote) + singleQuote;
}
async function atomicWriteFile(fullPath, data, expectedFile, expectedContent, existingBinding) {
  const binding = existingBinding || await openTrustedParent(fullPath, 'Write', true);
  const ownsBinding = !existingBinding;
  const directory = binding.directory;
  const targetPath = binding.targetPath;
  let handle;
  let tempPath;
  let published = false;
  try {
    let targetStats;
    try {
      targetStats = await fs.lstat(targetPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (expectedFile && (
      !targetStats || !targetStats.isFile()
      || targetStats.dev !== expectedFile.dev
      || targetStats.ino !== expectedFile.ino
      || targetStats.size !== expectedFile.size
      || targetStats.mtimeMs !== expectedFile.mtimeMs
      || targetStats.ctimeMs !== expectedFile.ctimeMs
    )) {
      const stale = new Error('Atomic write target changed before commit: ' + relativeWorkspacePath(fullPath));
      stale.code = 'ESTALE';
      throw stale;
    }
    if (expectedContent !== undefined) {
      const current = await fs.open(targetPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
      try {
        const actual = await current.readFile();
        if (!actual.equals(Buffer.from(expectedContent))) {
          const stale = new Error('Atomic write target content changed before commit: ' + relativeWorkspacePath(fullPath));
          stale.code = 'ESTALE';
          throw stale;
        }
      } finally {
        await current.close();
      }
    }
    const mode = targetStats && targetStats.isFile()
      ? targetStats.mode & 0o777
      : (0o664 & ~process.umask());
    const tempLeaf = '.ky-write-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    tempPath = path.join('/proc/self/fd/' + directory.fd, tempLeaf);
    handle = await fs.open(tempPath, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW, mode);
    await handle.writeFile(data);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, targetPath);
    published = true;
    await directory.sync();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (tempPath && !published) await fs.unlink(tempPath).catch(() => undefined);
    if (ownsBinding) await directory.close().catch(() => undefined);
  }
}
function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
async function readLineRange(fullPath, relPath, options) {
  const offset = Math.max(1, Math.trunc(Number(options.offset || 1)));
  const limit = Math.min(maxReadLines, Math.max(1, Math.trunc(Number(options.limit || maxReadLines))));
  const stream = fsSync.createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let lineNo = 0;
  let hasMore = false;
  let returnedBytes = 0;
  let byteLimitReached = false;
  let oversizedLine;
  const contentByteBudget = maxReadOutputBytes - 8 * 1024;
  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) continue;
      if (lines.length >= limit) {
        hasMore = true;
        break;
      }
      const separatorBytes = lines.length > 0 ? 1 : 0;
      const remainingBytes = contentByteBudget - returnedBytes - separatorBytes;
      if (remainingBytes <= 0) {
        hasMore = true;
        byteLimitReached = true;
        break;
      }
      const encoded = Buffer.from(line, 'utf8');
      let boundedLine = line;
      if (encoded.length > remainingBytes) {
        boundedLine = encoded.subarray(0, remainingBytes).toString('utf8').replace(/\\uFFFD$/, '');
        oversizedLine = { lineNo, bytes: encoded.length };
        byteLimitReached = true;
        hasMore = true;
      }
      lines.push(boundedLine);
      returnedBytes += separatorBytes + Buffer.byteLength(boundedLine, 'utf8');
      if (byteLimitReached) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (lines.length === 0) {
    return '...[no content: offset ' + offset + ' is beyond EOF for ' + relPath + '; total lines=' + lineNo + ']';
  }
  const endLine = offset + lines.length - 1;
  const suffix = oversizedLine
    ? '\\n...[truncated: line ' + oversizedLine.lineNo + ' is ' + oversizedLine.bytes + ' UTF-8 bytes and exceeds the Read budget; use Shell: sed -n \\'' + oversizedLine.lineNo + 'p\\' -- ' + quoteShellArgument(relPath) + ' | head -c ' + maxReadOutputBytes + ']'
    : byteLimitReached
    ? '\\n...[truncated: Read output reached ' + maxReadOutputBytes + ' UTF-8 bytes while showing ' + relPath + ' lines ' + offset + '-' + endLine + '; narrow the line range or use Search/Shell for targeted inspection]'
    : hasMore
    ? '\\n...[truncated: showing ' + relPath + ' lines ' + offset + '-' + endLine + '; next Read offset=' + (endLine + 1) + ', limit=' + limit + ']'
    : '\\n...[EOF: showing ' + relPath + ' lines ' + offset + '-' + endLine + '; total lines=' + lineNo + ']';
  return lines.join('\\n') + suffix;
}
${CONTAINER_EDIT_HELPER_SCRIPT}
(async () => {
  try {
    const request = JSON.parse(await readStdin() || '{}');
    if (request.op === 'readFile') {
      const resolvedRead = await resolveReadPath(request.path);
      try {
        const stablePath = resolvedRead.fdPath;
        const st = resolvedRead.stats;
        const relPath = resolvedRead.relativePath;
        const recoveredMetadata = resolvedRead.recovered ? { pathRecovered: true } : {};
        const imageMime = detectImageMime(await readFileBufferPrefix(stablePath, 32));
        if (imageMime) {
          if (st.size > maxReadImageSourceBytes) {
            throw new Error('Read: image too large (' + st.size + 'B > ' + maxReadImageSourceBytes + 'B)');
          }
          const data = await fs.readFile(stablePath);
          const payload = {
            sourcePath: relPath,
            fileName: path.basename(resolvedRead.openedPath),
            sizeBytes: data.byteLength,
            dataBase64: data.toString('base64'),
            mimeType: imageMime
          };
          process.stdout.write(JSON.stringify({
            ok: true,
            content: 'Read image ' + relPath + ' (' + imageMime + ', ' + data.byteLength + ' bytes). The image is attached as visual input.',
            metadata: {
              path: relPath,
              fileBytes: st.size,
              mimeType: imageMime,
              [readImagePayloadMetadataKey]: payload,
              ...recoveredMetadata
            }
          }));
          return;
        }
        if (request.offset !== undefined || request.limit !== undefined) {
          process.stdout.write(JSON.stringify({
            ok: true,
            content: await readLineRange(stablePath, relPath, request),
            metadata: { path: relPath, fileBytes: st.size, ranged: true, ...recoveredMetadata }
          }));
          return;
        }
        if (st.size <= maxFileBytes) {
          process.stdout.write(JSON.stringify({
            ok: true,
            content: await readFilePrefix(stablePath, st.size),
            metadata: { path: relPath, fileBytes: st.size, ...recoveredMetadata }
          }));
          return;
        }
        const prefix = await readFilePrefix(stablePath, maxFileBytes);
        process.stdout.write(JSON.stringify({
          ok: true,
          content: prefix + '\\n...[truncated: file ' + relPath + ' is ' + st.size + ' bytes; showing first ' + maxFileBytes + ' bytes. Use Read with {"path":"' + relPath + '","offset":1,"limit":' + maxReadLines + '} to continue by line chunks.]',
          metadata: { path: relPath, fileBytes: st.size, truncated: true, shownBytes: maxFileBytes, ...recoveredMetadata }
        }));
        return;
      } finally {
        await resolvedRead.handle.close().catch(() => undefined);
        await resolvedRead.directory.close().catch(() => undefined);
      }
    }
    if (request.op === 'writeFile') {
      const fullPath = resolveWorkspacePath(request.path);
      await atomicWriteFile(fullPath, String(request.content ?? ''));
      process.stdout.write(JSON.stringify({ ok: true, content: '' }));
      return;
    }
    if (request.op === 'edit') {
      const fullPath = resolveWorkspacePath(request.file_path);
      const requestedRelPath = relativeWorkspacePath(fullPath);
      assertNotDenied(requestedRelPath, editDenyPatterns, 'Edit: path "' + requestedRelPath + '" is in the deny list (sensitive config / credentials). Ask the admin via console if a change is genuinely required.');
      const opened = await openTrustedExistingFile(fullPath, 'Edit');
      const relPath = opened.relativePath;
      try {
        assertNotDenied(relPath, editDenyPatterns, 'Edit: opened path "' + relPath + '" is in the deny list (sensitive config / credentials).');
        const st = opened.stats;
        if (st.size > maxEditFileBytes) throw new Error('Edit: file too large (' + st.size + 'B > ' + maxEditFileBytes + 'B); use Write to rewrite.');
        const content = await opened.handle.readFile('utf-8');
        const applied = editApplyOperations(content, editCollectOperations(request), relPath);
        const updatedBytes = Buffer.from(applied.updatedContent, 'utf8');
        const bytesBefore = Buffer.byteLength(content, 'utf8');
        const bytesAfter = updatedBytes.length;
        const responseJson = JSON.stringify({
          ok: true,
          content: 'Edited ' + relPath + ' (' + applied.replacements + ' replacement' + (applied.replacements === 1 ? '' : 's') + ' across ' + applied.editCount + ' edit' + (applied.editCount === 1 ? '' : 's') + ', ' + bytesAfter + ' bytes).',
          metadata: {
            path: relPath,
            replacements: applied.replacements,
            occurrences: applied.occurrences,
            editCount: applied.editCount,
            fuzzyMatches: applied.fuzzyMatches,
            bomPreserved: applied.bomPreserved,
            lineEnding: applied.lineEnding,
            bytesBefore,
            bytesAfter,
            beforeContent: content,
            afterContent: applied.updatedContent
          }
        });
        const responseBytes = Buffer.byteLength(responseJson, 'utf8');
        if (responseBytes > maxContainerHelperOutputBytes) {
          throw new Error('Edit: prepared helper response too large (' + responseBytes + 'B > ' + maxContainerHelperOutputBytes + 'B).');
        }
        await atomicWriteFile(fullPath, updatedBytes, st, Buffer.from(content, 'utf8'), opened);
        process.stdout.write(responseJson);
        return;
      } finally {
        await opened.handle.close().catch(() => undefined);
        await opened.directory.close().catch(() => undefined);
      }
    }
    if (request.op === 'artifactCreate') {
      const fullPath = resolveWorkspacePath(request.file_path);
      const relPath = relativeWorkspacePath(fullPath);
      assertNotDenied(relPath, editDenyPatterns, 'CreateArtifact: refused sensitive path ' + relPath);
      const lst = await fs.lstat(fullPath);
      if (lst.isSymbolicLink()) throw new Error('CreateArtifact: refused symlink ' + relPath);
      const st = await fs.stat(fullPath);
      if (!st.isFile()) throw new Error('CreateArtifact: source must be a file');
      if (st.size > maxArtifactPayloadBytes) throw new Error('CreateArtifact: file too large (' + st.size + 'B > ' + maxArtifactPayloadBytes + 'B)');
      const data = await fs.readFile(fullPath);
      process.stdout.write(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          sourcePath: normalizePath(relPath),
          fileName: path.basename(fullPath),
          sizeBytes: data.byteLength,
          dataBase64: data.toString('base64'),
          kind: request.kind,
          mimeType: request.mime_type
        })
      }));
      return;
    }
    throw new Error('Unknown container helper op: ' + request.op);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
  }
})();
`;
