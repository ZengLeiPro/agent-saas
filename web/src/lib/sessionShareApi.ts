import { apiUrl } from "./apiBase";
import { authFetch } from "@/lib/authFetch";
import type { ApiSessionDetail } from "@/lib/sessionsApi";

export interface SessionShareSummary {
  enabled: boolean;
  shareId?: string;
  sessionId?: string;
  url?: string;
  debugMode?: boolean;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  accessCount?: number;
  lastAccessedAt?: string;
}

export interface PublicSessionShareResponse {
  share: {
    ownerUsername: string;
    debugMode: boolean;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    accessCount: number;
    lastAccessedAt?: string;
  };
  detail: ApiSessionDetail;
}

export interface SessionSharePreview {
  blockCount: number;
  files: Array<{ relativePath: string; fileName: string }>;
  defaultExpiresAt: string;
}

/**
 * 公开会话分享文件地址。必须经过 apiUrl()，否则 OSS/API 分域部署时
 * img/iframe/a/window.open 等浏览器原生请求会误打前端 OSS 域。
 */
export function publicSessionShareFileUrl(token: string, filePath: string): string {
  return apiUrl(
    `/api/share/sessions/${encodeURIComponent(token)}/file?path=${encodeURIComponent(filePath)}`,
  );
}

export async function getSessionShare(sessionId: string): Promise<SessionShareSummary> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`);
  if (!res.ok) throw new Error(await readApiError(res, "读取分享设置失败"));
  return res.json() as Promise<SessionShareSummary>;
}

export async function getSessionSharePreview(sessionId: string): Promise<SessionSharePreview> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/share-preview`);
  if (!res.ok) throw new Error(await readApiError(res, "读取公开内容预览失败"));
  return res.json() as Promise<SessionSharePreview>;
}

export async function updateSessionShare(
  sessionId: string,
  input: { confirmPublicText: true; filePaths: string[]; expiresAt?: string },
): Promise<SessionShareSummary> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res, "生成分享链接失败"));
  return res.json() as Promise<SessionShareSummary>;
}

export async function revokeSessionShare(sessionId: string): Promise<SessionShareSummary> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await readApiError(res, "撤销分享链接失败"));
  return res.json() as Promise<SessionShareSummary>;
}

export async function fetchPublicSessionShare(token: string): Promise<PublicSessionShareResponse> {
  const res = await fetch(apiUrl(`/api/share/sessions/${encodeURIComponent(token)}`), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await readApiError(res, res.status === 410 ? "分享链接已失效" : "分享链接不存在"));
  return res.json() as Promise<PublicSessionShareResponse>;
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null) as { error?: string } | null;
  return data?.error || fallback;
}
