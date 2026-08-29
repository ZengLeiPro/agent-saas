import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { toByteArray } from 'base64-js';
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';

// Divisible by three so every non-final base64 chunk has no padding ambiguity.
const HASH_CHUNK_BYTES = 768 * 1024;

type ReadChunk = (
  uri: string,
  options: { encoding: EncodingType; position: number; length: number },
) => Promise<string>;

/** Incrementally hashes an APK without loading the complete binary into JS memory. */
export async function sha256File(
  uri: string,
  expectedSize: number,
  readChunk: ReadChunk = readAsStringAsync,
): Promise<string> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error('Cannot hash a file with an invalid expected size');
  }

  const digest = sha256.create();
  for (let position = 0; position < expectedSize; position += HASH_CHUNK_BYTES) {
    const length = Math.min(HASH_CHUNK_BYTES, expectedSize - position);
    const encoded = await readChunk(uri, {
      encoding: EncodingType.Base64,
      position,
      length,
    });
    const bytes = toByteArray(encoded);
    if (bytes.length !== length) {
      throw new Error(`APK read length mismatch at byte ${position}`);
    }
    digest.update(bytes);
  }
  return bytesToHex(digest.digest());
}
