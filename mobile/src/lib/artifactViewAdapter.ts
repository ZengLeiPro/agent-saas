import {
  authFetch,
  ARTIFACT_VIEW_POLICY_VERSION,
  formatFileSize,
  parseArtifactReadGrant,
  type ArtifactReadGrant,
  type ArtifactViewKind,
} from '@agent/shared';

export type MobileArtifactViewer = 'native-image' | 'native-pdf' | 'native-text' | 'native-audio' | 'native-video' | 'download-only';

const MOBILE_VIEWERS: Record<ArtifactViewKind, MobileArtifactViewer> = {
  image: 'native-image',
  pdf: 'native-pdf',
  markdown: 'native-text',
  html: 'download-only',
  text: 'native-text',
  source: 'native-text',
  audio: 'native-audio',
  video: 'native-video',
  'download-only': 'download-only',
};

export function selectMobileArtifactViewer(grant: ArtifactReadGrant): MobileArtifactViewer {
  return MOBILE_VIEWERS[grant.descriptor.viewKind] ?? 'download-only';
}

export function mobileArtifactWarning(grant: ArtifactReadGrant): string {
  const { descriptor } = grant;
  return [
    '此文件包含主动内容或未知格式，下载到本机后可能执行代码。',
    '',
    `类型：${descriptor.safeMime || '未知'}`,
    `大小：${formatFileSize(descriptor.size)}`,
    '来源：当前会话 Artifact',
    '',
    '下载后请仅使用可信原生应用打开。',
  ].join('\n');
}

export class MobileArtifactReadError extends Error {
  constructor(readonly status: number, readonly reason?: string, message = 'Artifact 加载失败') { super(message); }
}

/** The only mobile read entry point: caller supplies artifactId, never URL/path/HTML. */
export async function fetchMobileArtifactGrant(artifactId: string, download = false): Promise<ArtifactReadGrant> {
  const query = `viewPolicyVersion=${ARTIFACT_VIEW_POLICY_VERSION}${download ? '&download=true' : ''}`;
  const response = await authFetch(`/api/artifacts/${encodeURIComponent(artifactId)}/read-url?${query}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string; error?: string } | null;
    throw new MobileArtifactReadError(response.status, body?.code, body?.error);
  }
  const grant = parseArtifactReadGrant(await response.json());
  if (!grant || grant.descriptor.artifactId !== artifactId) {
    throw new MobileArtifactReadError(502, 'malformed_descriptor', 'Artifact 安全描述符无效');
  }
  return grant;
}

/** Retry an expired short URL once; the second grant is a full re-authorization. */
export async function withOneArtifactRefresh<T>(artifactId: string, operation: (grant: ArtifactReadGrant) => Promise<T>, download = false): Promise<T> {
  let grant = await fetchMobileArtifactGrant(artifactId, download);
  try {
    return await operation(grant);
  } catch (error) {
    if (!(error instanceof MobileArtifactReadError) || error.status !== 401) throw error;
    grant = await fetchMobileArtifactGrant(artifactId, download);
    return operation(grant);
  }
}
