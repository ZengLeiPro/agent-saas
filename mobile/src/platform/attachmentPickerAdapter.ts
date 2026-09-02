export interface MobilePickerSource {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
}

/**
 * The only in-memory holder for picker/camera/gallery local URIs. Shared state, logs,
 * analytics, WS, queue and transcript receive only localIntentId/uploadRequestId/attachmentId.
 */
export class AttachmentPickerAdapter {
  private readonly sources = new Map<string, MobilePickerSource>();

  select(localIntentId: string, source: MobilePickerSource): void {
    if (!localIntentId || this.sources.has(localIntentId)) throw new Error('localIntentId must be unique');
    this.sources.set(localIntentId, source);
  }

  read(localIntentId: string): MobilePickerSource {
    const source = this.sources.get(localIntentId);
    if (!source) throw new Error('本地文件已不可用，请重新选择');
    return source;
  }

  release(localIntentId: string): void {
    this.sources.delete(localIntentId);
  }

  fence(): void {
    this.sources.clear();
  }

  get size(): number {
    return this.sources.size;
  }
}
