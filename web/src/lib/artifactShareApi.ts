import { apiUrl, resolveApiAssetUrl } from "@/lib/apiBase";
import { authFetch } from "@/lib/authFetch";

export interface ArtifactMetadata {
  artifactId?: string;
  id?: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  kind?: "file" | "screenshot" | "patch" | "log" | "blob";
}

export interface ArtifactShareSummary {
  enabled: boolean;
  token?: string;
  shareToken?: string;
  url?: string;
  publicPath?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  allowDownload?: boolean;
  accessCount?: number;
  lastAccessedAt?: string;
}

export interface PublicArtifactShareResponse {
  share: ArtifactShareSummary;
  artifact: ArtifactMetadata;
  contentUrl: string;
}

export function publicArtifactPageUrl(share: ArtifactShareSummary): string | null {
  const providedPath = share.url || share.publicPath;
  if (providedPath) {
    try {
      return new URL(providedPath, window.location.origin).toString();
    } catch {
      return null;
    }
  }
  const token = share.token || share.shareToken;
  return token
    ? new URL(`/public/artifacts/${encodeURIComponent(token)}`, window.location.origin).toString()
    : null;
}

export function publicArtifactContentUrl(token: string): string {
  return apiUrl(`/api/share/artifacts/${encodeURIComponent(token)}/content`);
}

/** 将 API 相对地址收口到 API 域；签名绝对 URL、blob/data URL 保持不变。 */
export function resolveArtifactContentUrl(url: string): string {
  return resolveApiAssetUrl(url) || url;
}

export async function getArtifactContentUrl(artifactId: string): Promise<string> {
  // 预览统一走 API proxy：OSS 直链未必开放 CORS，HTML/text fetch 会因此失败；
  // 下载按钮仍可使用同一个短期签名地址，不暴露长期存储 URL。
  const res = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/read-url?proxy=true`);
  if (!res.ok) throw new Error(await readApiError(res, "读取 Artifact 失败"));
  const data = await res.json() as { url?: string };
  if (!data.url) throw new Error("读取 Artifact 失败：响应缺少内容地址");
  return resolveArtifactContentUrl(data.url);
}

export async function getArtifactShare(artifactId: string): Promise<ArtifactShareSummary> {
  const res = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/share`);
  if (!res.ok) throw new Error(await readApiError(res, "读取分享设置失败"));
  const data = await res.json() as ArtifactShareSummary | { share: Omit<ArtifactShareSummary, "enabled"> | null };
  if ("share" in data) return data.share ? { enabled: true, ...data.share } : { enabled: false };
  return data;
}

export async function createArtifactShare(
  artifactId: string,
  input: { confirmPublicArtifact: true; expiresAt?: string; allowDownload?: boolean },
): Promise<ArtifactShareSummary> {
  const res = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res, "生成分享链接失败"));
  const data = await res.json() as ArtifactShareSummary | { share: Omit<ArtifactShareSummary, "enabled"> };
  return "share" in data ? { enabled: true, ...data.share } : data;
}

export async function revokeArtifactShare(artifactId: string): Promise<ArtifactShareSummary> {
  const res = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/share`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await readApiError(res, "撤销分享链接失败"));
  await res.json().catch(() => null);
  return { enabled: false };
}

export async function fetchPublicArtifactShare(token: string): Promise<PublicArtifactShareResponse> {
  const res = await fetch(apiUrl(`/api/share/artifacts/${encodeURIComponent(token)}`), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readApiError(
      res,
      res.status === 410 ? "分享链接已过期或被撤销" : "分享链接不存在",
    ));
  }
  const data = await res.json() as PublicArtifactShareResponse;
  return {
    ...data,
    contentUrl: data.contentUrl
      ? resolveArtifactContentUrl(data.contentUrl)
      : publicArtifactContentUrl(token),
  };
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null) as { error?: string; message?: string } | null;
  return data?.error || data?.message || fallback;
}
