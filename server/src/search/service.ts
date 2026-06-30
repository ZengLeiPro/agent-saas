import {
  getTranscriptPath,
  listSessions,
  parseTranscriptFile,
  summarizeTranscript,
  type TranscriptBlock,
  type SessionListItem,
} from "../data/transcripts/index.js";
import { readSessionMeta, type SessionMeta } from "../data/transcripts/meta.js";
import type { UserStore } from "../data/users/store.js";
import { resolveUserCwd } from "../workspace/resolver.js";
import { canExposeSessionToUser } from "../data/sessions/access.js";
import type {
  SearchContext,
  SessionSearchHit,
  SessionSearchMatch,
  SessionSearchMatchKind,
  SessionSearchQuery,
  SessionSearchResponse,
} from "./types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_CANDIDATE_LIMIT = 500;
const MAX_MATCHES_PER_SESSION = 5;
const MAX_SNIPPET_LENGTH = 180;
const MAX_QUERY_LENGTH = 100;

export interface SessionSearchServiceOptions {
  agentCwd: string;
  userStore?: UserStore;
  candidateLimit?: number;
}

interface SearchCandidate {
  item: SessionListItem;
  transcriptPath: string;
  meta: SessionMeta;
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase();
}

function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf-8"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf-8").toString("base64url");
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]{3,}\s*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{2,}/g, " ")
    .trim();
}

function buildSnippet(text: string, matchIndex: number, queryLength: number): { snippet: string; start: number; end: number } {
  const radius = Math.floor((MAX_SNIPPET_LENGTH - queryLength) / 2);
  const rawStart = Math.max(0, matchIndex - Math.max(radius, 30));
  const rawEnd = Math.min(text.length, matchIndex + queryLength + Math.max(radius, 30));
  const prefix = rawStart > 0 ? "…" : "";
  const suffix = rawEnd < text.length ? "…" : "";
  const snippetBody = text.slice(rawStart, rawEnd).replace(/\s+/g, " ").trim();
  const snippet = `${prefix}${snippetBody}${suffix}`;
  const snippetMatchStart = prefix.length + Math.max(0, matchIndex - rawStart);
  return {
    snippet,
    start: snippetMatchStart,
    end: snippetMatchStart + queryLength,
  };
}

function blockRole(block: TranscriptBlock): SessionSearchMatch["role"] {
  if (block.kind === "prompt") return "user";
  if (block.kind === "text" || block.kind === "thinking") return "assistant";
  if (block.kind === "tool_use" || block.kind === "tool_result") return "tool";
  return "system";
}

function blockMatchKind(block: TranscriptBlock): SessionSearchMatchKind {
  if (block.kind === "prompt" || block.kind === "text" || block.kind === "thinking") return "message";
  if (block.kind === "tool_use" || block.kind === "tool_result") return "tool";
  return "meta";
}

function scoreForMatch(kind: SessionSearchMatchKind, role?: SessionSearchMatch["role"]): number {
  if (kind === "title") return 100;
  if (kind === "preview") return 50;
  if (kind === "message" && role === "user") return 40;
  if (kind === "message") return 25;
  if (kind === "tool") return 15;
  return 5;
}

function collectMatch(
  matches: SessionSearchMatch[],
  text: string | undefined,
  normalizedQuery: string,
  kind: SessionSearchMatchKind,
  options?: { block?: TranscriptBlock; role?: SessionSearchMatch["role"] },
): number {
  if (!text || matches.length >= MAX_MATCHES_PER_SESSION) return 0;
  const cleanText = stripMarkdown(text);
  const idx = normalizeText(cleanText).indexOf(normalizedQuery);
  if (idx < 0) return 0;
  const snippet = buildSnippet(cleanText, idx, normalizedQuery.length);
  const role = options?.role ?? (options?.block ? blockRole(options.block) : undefined);
  matches.push({
    kind,
    ...(options?.block ? { blockId: options.block.id, tsMs: options.block.tsMs } : {}),
    ...(role ? { role } : {}),
    snippet: snippet.snippet,
    ranges: [{ start: snippet.start, end: snippet.end }],
  });
  return scoreForMatch(kind, role);
}

function sourceFromMeta(meta: SessionMeta): { type: "web" | "dingtalk" | "cron"; label: string } {
  if (meta.channel === "cron") return { type: "cron", label: meta.cronJobName || "定时任务" };
  if (meta.channel === "dingtalk") return { type: "dingtalk", label: "钉钉" };
  return { type: "web", label: "WEB" };
}

export class SessionSearchService {
  constructor(private readonly options: SessionSearchServiceOptions) {}

  async searchSessions(
    context: SearchContext,
    rawQuery: SessionSearchQuery,
  ): Promise<SessionSearchResponse> {
    const query = normalizeQuery(rawQuery.q);
    if (!query) return { hits: [], hasMore: false };

    const requestedLimit = Number.isFinite(rawQuery.limit) ? rawQuery.limit : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requestedLimit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = parseCursor(rawQuery.cursor);
    const normalizedQuery = normalizeText(query);

    const userCwd = resolveUserCwd(
      this.options.agentCwd,
      context.user
        ? {
            id: context.user.sub,
            username: context.user.username,
            role: context.user.role,
            tenantId: context.user.tenantId,
          }
        : undefined,
    );
    const owner = context.user
      ? { tenantId: context.user.tenantId, userId: context.user.sub }
      : undefined;

    const candidateLimit = this.options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    const listed = await listSessions(userCwd, { limit: candidateLimit, owner });
    const candidates = await this.loadCandidates(userCwd, listed.items, context.user, owner);
    const hits: SessionSearchHit[] = [];

    for (const candidate of candidates) {
      const hit = await this.searchCandidate(candidate, normalizedQuery);
      if (hit) hits.push(hit);
    }

    hits.sort((a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs);
    const page = hits.slice(offset, offset + limit);
    const hasMore = offset + limit < hits.length;
    return {
      hits: page,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor(offset + limit) } : {}),
    };
  }

  private async loadCandidates(
    userCwd: string,
    items: SessionListItem[],
    user: SearchContext["user"],
    owner?: { tenantId?: string; userId?: string },
  ): Promise<SearchCandidate[]> {
    const out: SearchCandidate[] = [];
    for (const item of items) {
      const transcriptPath = item.transcriptPath ?? getTranscriptPath(userCwd, item.sessionId, owner);
      const meta = await readSessionMeta(transcriptPath);
      if (!meta || !canExposeSessionToUser(user, meta, this.options.userStore)) continue;
      out.push({ item, transcriptPath, meta });
    }
    return out;
  }

  private async searchCandidate(
    candidate: SearchCandidate,
    normalizedQuery: string,
  ): Promise<SessionSearchHit | null> {
    const matches: SessionSearchMatch[] = [];
    let score = 0;

    const summary = await summarizeTranscript(candidate.transcriptPath).catch(() => undefined);
    const title = candidate.meta.customTitle || candidate.meta.generatedTitle || candidate.meta.cronJobName || summary?.title;
    const preview = summary?.preview ? stripMarkdown(summary.preview).slice(0, 200) : undefined;
    const createdAtMs = summary?.createdAtMs ?? (candidate.meta.createdAt ? Date.parse(candidate.meta.createdAt) : undefined);

    score += collectMatch(matches, title, normalizedQuery, "title");
    score += collectMatch(matches, preview, normalizedQuery, "preview");

    if (matches.length < MAX_MATCHES_PER_SESSION) {
      const parsed = await parseTranscriptFile(candidate.transcriptPath).catch(() => undefined);
      for (const block of parsed?.blocks ?? []) {
        if (matches.length >= MAX_MATCHES_PER_SESSION) break;
        if (!block.content) continue;
        const kind = blockMatchKind(block);
        score += collectMatch(matches, block.content, normalizedQuery, kind, { block });
      }
    }

    if (!matches.length || score <= 0) return null;
    // Slight recency tiebreaker without dominating semantic score.
    const ageDays = Math.max(0, (Date.now() - candidate.item.updatedAtMs) / 86_400_000);
    const recencyBoost = Math.max(0, 10 - Math.min(10, ageDays / 7));

    return {
      sessionId: candidate.item.sessionId,
      title,
      preview,
      source: sourceFromMeta(candidate.meta),
      updatedAtMs: candidate.item.updatedAtMs,
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      score: score + recencyBoost,
      matches,
    };
  }
}

export function createSessionSearchService(options: SessionSearchServiceOptions): SessionSearchService {
  return new SessionSearchService(options);
}
