import { createTwoFilesPatch, diffLines } from 'diff';

export const MAX_EDIT_DIFF_BYTES = 64 * 1024;
export const MAX_EDIT_RESULT_BYTES = 1_000_000;
export const MAX_EDIT_REPLACEMENTS = 10_000;

export type EditOperation = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type AppliedWorkspaceEdits = {
  updatedContent: string;
  replacements: number;
  occurrences: number;
  editCount: number;
  fuzzyMatches: number;
  bomPreserved: boolean;
  lineEnding: '\r\n' | '\n';
  diff: string;
  diffTruncated: boolean;
  firstChangedLine: number;
};

type MatchMode = 'exact' | 'fuzzy';

type PlannedReplacement = {
  editIndex: number;
  start: number;
  end: number;
  newText: string;
  matchMode: MatchMode;
};

type FuzzyView = {
  text: string;
  starts: number[];
  ends: number[];
};

const SMART_SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
const SMART_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F]/g;
const UNICODE_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const SPECIAL_SPACES = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfCount = content.match(/\r\n/g)?.length ?? 0;
  const lfCount = (content.match(/\n/g)?.length ?? 0) - crlfCount;
  if (crlfCount === 0) return '\n';
  if (crlfCount !== lfCount) return crlfCount > lfCount ? '\r\n' : '\n';
  const firstNewline = content.indexOf('\n');
  return firstNewline > 0 && content[firstNewline - 1] === '\r' ? '\r\n' : '\n';
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(UNICODE_DASHES, '-')
    .replace(SPECIAL_SPACES, ' ');
}

function normalizeFuzzyCodePoint(value: string): string {
  return value
    .normalize('NFKC')
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(UNICODE_DASHES, '-')
    .replace(SPECIAL_SPACES, ' ');
}

function appendMappedSegment(
  segment: string,
  segmentOffset: number,
  output: string[],
  starts: number[],
  ends: number[],
): void {
  const units: Array<{ value: string; start: number; end: number }> = [];
  for (const grapheme of GRAPHEME_SEGMENTER.segment(segment)) {
    const start = segmentOffset + grapheme.index;
    const end = start + grapheme.segment.length;
    const normalized = normalizeFuzzyCodePoint(grapheme.segment);
    for (let i = 0; i < normalized.length; i++) {
      units.push({ value: normalized[i]!, start, end });
    }
  }
  while (units.length > 0 && /\s/u.test(units[units.length - 1]!.value)) {
    units.pop();
  }
  for (const unit of units) {
    output.push(unit.value);
    starts.push(unit.start);
    ends.push(unit.end);
  }
}

function createFuzzyView(content: string): FuzzyView {
  const output: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    appendMappedSegment(content.slice(lineStart, lineEnd), lineStart, output, starts, ends);
    if (newline === -1) break;
    output.push('\n');
    starts.push(newline);
    ends.push(newline + 1);
    lineStart = newline + 1;
  }
  return { text: output.join(''), starts, ends };
}

function createLineEndingView(content: string): FuzzyView {
  const output: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\r') {
      const end = content[i + 1] === '\n' ? i + 2 : i + 1;
      output.push('\n');
      starts.push(i);
      ends.push(end);
      if (end === i + 2) i++;
      continue;
    }
    output.push(content[i]!);
    starts.push(i);
    ends.push(i + 1);
  }
  return { text: output.join(''), starts, ends };
}

function mapViewRanges(
  view: FuzzyView,
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  return ranges.map((range) => ({
    start: view.starts[range.start]!,
    end: view.ends[range.end - 1]!,
  }));
}

function findAllRanges(content: string, needle: string): Array<{ start: number; end: number }> {
  if (needle.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const start = content.indexOf(needle, from);
    if (start === -1) break;
    ranges.push({ start, end: start + needle.length });
    if (ranges.length > MAX_EDIT_REPLACEMENTS) {
      throw new Error(
        `Edit: match count exceeds ${MAX_EDIT_REPLACEMENTS}; use Write or Shell for a bulk rewrite.`,
      );
    }
    from = start + needle.length;
  }
  return ranges;
}

function fuzzyRanges(view: FuzzyView, oldText: string): Array<{ start: number; end: number }> {
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText.length === 0) return [];
  return findAllRanges(view.text, fuzzyOldText)
    .filter((range) => {
      const startsInsideMappedUnit =
        range.start > 0 && view.starts[range.start] === view.starts[range.start - 1];
      const endsInsideMappedUnit =
        range.end < view.text.length && view.ends[range.end - 1] === view.ends[range.end];
      return !startsInsideMappedUnit && !endsInsideMappedUnit;
    })
    .map((range) => ({
      start: view.starts[range.start]!,
      end: view.ends[range.end - 1]!,
    }));
}

function operationLabel(editIndex: number, editCount: number): string {
  return editCount === 1 ? 'old_string' : `edits[${editIndex}].old_string`;
}

function planReplacements(
  content: string,
  operations: EditOperation[],
  path: string,
  lineEnding: '\r\n' | '\n',
  hasBom: boolean,
): {
  replacements: PlannedReplacement[];
  occurrences: number;
  fuzzyMatches: number;
} {
  const lineEndingView = createLineEndingView(content);
  const fuzzyView = createFuzzyView(lineEndingView.text);
  const planned: PlannedReplacement[] = [];
  let occurrences = 0;
  let fuzzyMatches = 0;

  operations.forEach((operation, editIndex) => {
    const oldIncludesBom = operation.old_string.startsWith('\uFEFF');
    const oldText = normalizeToLf(
      oldIncludesBom ? operation.old_string.slice(1) : operation.old_string,
    );
    const newText = restoreLineEndings(normalizeToLf(operation.new_string), lineEnding);
    const label = operationLabel(editIndex, operations.length);
    if (oldText.length === 0) {
      throw new Error(`Edit: ${label} is empty; use Write for new files.`);
    }
    if (oldText === newText) {
      throw new Error(`Edit: ${label} equals new_string; no-op.`);
    }

    let matchMode: MatchMode = 'exact';
    let viewRanges = findAllRanges(lineEndingView.text, oldText);
    if (viewRanges.length === 0) {
      matchMode = 'fuzzy';
      viewRanges = fuzzyRanges(fuzzyView, oldText);
    }
    if (oldIncludesBom) {
      viewRanges = hasBom ? viewRanges.filter((range) => range.start === 0) : [];
    }
    if (viewRanges.length === 0) {
      throw new Error(
        `Edit: ${label} not found. It must match including whitespace and newlines; fuzzy quote/space normalization also found no match.`,
      );
    }
    if (!operation.replace_all && viewRanges.length > 1) {
      throw new Error(
        `Edit: ${label} matched ${viewRanges.length} times; supply more surrounding context or set replace_all=true.`,
      );
    }

    occurrences += viewRanges.length;
    const selectedViewRanges = operation.replace_all ? viewRanges : viewRanges.slice(0, 1);
    const selected = mapViewRanges(lineEndingView, selectedViewRanges);
    if (planned.length + selected.length > MAX_EDIT_REPLACEMENTS) {
      throw new Error(
        `Edit: total replacement count exceeds ${MAX_EDIT_REPLACEMENTS}; split the operation or use Write/Shell.`,
      );
    }
    if (matchMode === 'fuzzy') fuzzyMatches += selected.length;
    for (const range of selected) {
      const replacementText =
        hasBom && range.start === 0 && newText.startsWith('\uFEFF') ? newText.slice(1) : newText;
      planned.push({
        editIndex,
        start: range.start,
        end: range.end,
        newText: replacementText,
        matchMode,
      });
    }
  });

  planned.sort((a, b) => a.start - b.start || a.end - b.end || a.editIndex - b.editIndex);
  for (let i = 1; i < planned.length; i++) {
    const previous = planned[i - 1]!;
    const current = planned[i]!;
    if (previous.end > current.start) {
      throw new Error(
        `Edit: edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}; merge them into one edit or target disjoint regions.`,
      );
    }
  }

  return { replacements: planned, occurrences, fuzzyMatches };
}

function applyPlannedReplacements(content: string, replacements: PlannedReplacement[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    chunks.push(content.slice(cursor, replacement.start), replacement.newText);
    cursor = replacement.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join('');
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const suffix = `\n... [unified diff truncated at ${maxBytes} UTF-8 bytes]\n`;
  const prefixBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  const prefix = Buffer.from(text, 'utf8')
    .subarray(0, prefixBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return { text: prefix + suffix, truncated: true };
}

function countChangedLine(oldContent: string, newContent: string): number {
  let newLine = 1;
  for (const part of diffLines(oldContent, newContent)) {
    if (part.added || part.removed) return newLine;
    newLine += part.count ?? 0;
  }
  return 1;
}

export function createEditDiff(
  path: string,
  oldContent: string,
  newContent: string,
): {
  diff: string;
  diffTruncated: boolean;
  firstChangedLine: number;
} {
  const patch = createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: 4,
  });
  const bounded = truncateUtf8(patch, MAX_EDIT_DIFF_BYTES);
  return {
    diff: bounded.text,
    diffTruncated: bounded.truncated,
    firstChangedLine: countChangedLine(oldContent, newContent),
  };
}

export function applyWorkspaceEdits(
  content: string,
  operations: EditOperation[],
  path: string,
): AppliedWorkspaceEdits {
  if (operations.length === 0) throw new Error('Edit: at least one edit is required.');
  const { bom, text } = stripBom(content);
  const lineEnding = detectLineEnding(text);
  const plan = planReplacements(text, operations, path, lineEnding, bom.length > 0);
  const updatedText = applyPlannedReplacements(text, plan.replacements);
  if (updatedText === text) {
    throw new Error(
      `Edit: no changes made to ${path}; the replacement produced identical content.`,
    );
  }
  const updatedContent = bom + updatedText;
  const updatedBytes = Buffer.byteLength(updatedContent, 'utf8');
  if (updatedBytes > MAX_EDIT_RESULT_BYTES) {
    throw new Error(
      `Edit: result too large (${updatedBytes}B > ${MAX_EDIT_RESULT_BYTES}B); use Write for intentional full-file rewrites.`,
    );
  }
  const diff = createEditDiff(path, content, updatedContent);
  return {
    updatedContent,
    replacements: plan.replacements.length,
    occurrences: plan.occurrences,
    editCount: operations.length,
    fuzzyMatches: plan.fuzzyMatches,
    bomPreserved: bom.length > 0,
    lineEnding,
    ...diff,
  };
}
