import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useAuth } from '../contexts/AuthContext';
import { incomingShareCoordinator, publishIncomingShare } from '../platform/incomingShareInbox';

function stableIntentId(input: string): string {
  // FNV-1a is an idempotency key, not a security boundary; upload requestIds remain random UUIDs.
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `share-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Consumes ACTION_SEND/SEND_MULTIPLE once on startup or foreground. Sources are copied to the
 * owner sandbox before resetShareIntent releases the provider grant; canonical state never sees URI.
 */
export function useShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const { user, loading } = useAuth();
  const router = useRouter();
  const lastHandledIdRef = useRef<string | null>(null);

  useEffect(() => {
    incomingShareCoordinator.fenceOwner();
    lastHandledIdRef.current = null;
  }, [user?.id, user?.tenantId]);

  useEffect(() => {
    if (error) console.warn('[ShareIntent] adapter error');
  }, [error]);

  useEffect(() => {
    if (loading || !hasShareIntent || !user) return;
    const text = [shareIntent?.text, shareIntent?.webUrl].filter((value): value is string => typeof value === 'string' && !!value.trim()).join('\n');
    const files = shareIntent?.files ?? [];
    const fingerprint = JSON.stringify({
      text,
      files: files.map((file) => ({ name: file.fileName, mimeType: file.mimeType, size: file.size ?? 0 })),
    });
    const intentId = stableIntentId(fingerprint);
    if (lastHandledIdRef.current === intentId) return;
    lastHandledIdRef.current = intentId;

    let grantReleased = false;
    const releaseGrant = () => {
      if (grantReleased) return;
      grantReleased = true;
      resetShareIntent();
    };
    void incomingShareCoordinator.consume(
      { userId: user.id, tenantId: user.tenantId },
      {
        intentId,
        text,
        files: files.map((file) => ({
          uri: file.path,
          name: file.fileName || 'shared-file',
          mimeType: file.mimeType || 'application/octet-stream',
          size: file.size ?? 0,
        })),
        onSourcesStaged: releaseGrant,
      },
    ).then((share) => {
      releaseGrant();
      publishIncomingShare(share);
      router.push('/share-target');
    }).catch(() => {
      releaseGrant();
      console.warn('[ShareIntent] consume failed');
    });
  }, [hasShareIntent, shareIntent, user, loading, resetShareIntent, router]);
}
