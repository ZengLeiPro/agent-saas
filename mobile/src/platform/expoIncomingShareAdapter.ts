import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import {
  CACHE_KEY_PREFIX,
  CacheKeyBuilder,
  authFetch,
  canonicalSerialize,
  type AttachmentDraft,
  type CacheOwner,
  type IncomingShare,
} from '@agent/shared';
import type { IncomingShareDraftStore, IncomingSharePlatformAdapter, IncomingShareSource } from './incomingShareCoordinator';

interface UploadResponseFile {
  attachmentId?: string;
  originalName: string;
  size: number;
  mimeType: string;
  isImage: boolean;
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'application/pdf': return '.pdf';
    default: throw new Error('unsupported_incoming_share_mime');
  }
}

function ownerDirectory(owner: CacheOwner): Directory {
  return new Directory(Paths.cache, 'incoming-share-v1', owner.tenantId, owner.userId);
}

function stagedFile(owner: CacheOwner, draft: AttachmentDraft): File {
  return new File(ownerDirectory(owner), `${draft.draftId}${extensionFor(draft.mimeType)}`);
}

function checkedUpload(file: UploadResponseFile | undefined): Required<Pick<UploadResponseFile, 'attachmentId'>> & UploadResponseFile {
  if (!file?.attachmentId) throw new Error('upload_attachment_id_missing');
  return { ...file, attachmentId: file.attachmentId };
}

/** Expo implementation: content URI is copied synchronously while the grant is live, then never retained. */
export class ExpoIncomingShareAdapter implements IncomingSharePlatformAdapter {
  availableDiskBytes(): number { return Paths.availableDiskSpace; }

  async stage(owner: CacheOwner, draft: AttachmentDraft, source: IncomingShareSource) {
    const directory = ownerDirectory(owner);
    directory.create({ intermediates: true, idempotent: true });
    const destination = stagedFile(owner, draft);
    if (destination.exists) destination.delete();
    const original = new File(source.uri);
    if (!original.exists) throw Object.assign(new Error('source unavailable'), { code: 'SOURCE_REVOKED' });
    original.copy(destination);
    if (!destination.exists || typeof destination.size !== 'number') throw Object.assign(new Error('stage copy failed'), { code: 'SOURCE_MISSING' });
    const bytes = await destination.bytes();
    return { size: destination.size, head: bytes.slice(0, 8192) };
  }

  async upload(owner: CacheOwner, draft: AttachmentDraft) {
    const local = stagedFile(owner, draft);
    if (!local.exists) throw Object.assign(new Error('staged source missing'), { code: 'SOURCE_MISSING' });
    const form = new FormData();
    form.append('files', { uri: local.uri, name: draft.name, type: draft.mimeType } as unknown as Blob);
    const response = await authFetch('/api/upload', {
      method: 'POST',
      headers: {
        'X-Upload-Request-Id': draft.requestId,
        'X-Upload-Source': 'incoming-share',
      },
      body: form,
    });
    if (!response.ok) {
      const code = response.status === 0 || response.status >= 500 ? 'OFFLINE' : `UPLOAD_${response.status}`;
      throw Object.assign(new Error(`上传失败: ${response.status}`), { code });
    }
    const body = await response.json() as { success?: boolean; files?: UploadResponseFile[]; error?: string };
    if (!body.success) throw new Error(body.error || '上传失败');
    return checkedUpload(body.files?.[0]);
  }

  async queryUpload(_owner: CacheOwner, requestId: string) {
    let response: Response;
    try {
      response = await authFetch(`/api/uploads/requests/${encodeURIComponent(requestId)}`);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('offline'), { code: 'OFFLINE' });
    }
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`查询上传状态失败: ${response.status}`), { code: response.status >= 500 ? 'OFFLINE' : `UPLOAD_${response.status}` });
    const body = await response.json() as { success?: boolean; files?: UploadResponseFile[] };
    return checkedUpload(body.files?.[0]);
  }

  async release(owner: CacheOwner, draftId: string): Promise<void> {
    const directory = ownerDirectory(owner);
    if (!directory.exists) return;
    for (const entry of directory.list()) {
      if (entry instanceof File && entry.name.startsWith(`${draftId}.`) && entry.exists) entry.delete();
    }
  }
}

/** Cache-v2 owner keys contain only canonical path-free share state; sandbox bytes stay outside backup. */
export class AsyncStorageIncomingShareDraftStore implements IncomingShareDraftStore {
  private key(owner: CacheOwner, resource: 'draft-attachments' | 'draft-metadata', intentId: string): string {
    return CacheKeyBuilder.build(owner, resource, intentId);
  }
  async get(owner: CacheOwner, intentId: string): Promise<IncomingShare | null> {
    const [draft, completed] = await AsyncStorage.multiGet([
      this.key(owner, 'draft-attachments', intentId),
      this.key(owner, 'draft-metadata', intentId),
    ]);
    const raw = draft[1] ?? completed[1];
    return raw ? JSON.parse(raw) as IncomingShare : null;
  }
  async put(owner: CacheOwner, share: IncomingShare): Promise<void> {
    const completed = share.status === 'uploaded';
    const target = this.key(owner, completed ? 'draft-metadata' : 'draft-attachments', share.intentId);
    const obsolete = this.key(owner, completed ? 'draft-attachments' : 'draft-metadata', share.intentId);
    await AsyncStorage.setItem(target, canonicalSerialize(share));
    await AsyncStorage.removeItem(obsolete);
  }
  async remove(owner: CacheOwner, intentId: string): Promise<void> {
    await AsyncStorage.multiRemove([
      this.key(owner, 'draft-attachments', intentId),
      this.key(owner, 'draft-metadata', intentId),
    ]);
  }
  async list(owner: CacheOwner): Promise<IncomingShare[]> {
    const prefix = `${CACHE_KEY_PREFIX}:tenant=${owner.tenantId}:user=${owner.userId}:resource=`;
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix)
      && (key.includes(':resource=draft-attachments:') || key.includes(':resource=draft-metadata:')));
    if (!keys.length) return [];
    return (await AsyncStorage.multiGet(keys)).flatMap(([, raw]) => raw ? [JSON.parse(raw) as IncomingShare] : []);
  }
}
