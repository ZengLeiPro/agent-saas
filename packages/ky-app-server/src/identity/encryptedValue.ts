import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function decodeEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value.replace(/=+$/u, '')) {
    throw new Error('部署密钥加密主密钥必须是 32 字节 base64url');
  }
  return key;
}

export function encryptValue(value: Uint8Array, key: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptValue(value: string, key: Uint8Array): Buffer {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('encrypted_value_malformed');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part!, 'base64url'));
  if (iv!.length !== 12 || tag!.length !== 16) throw new Error('encrypted_value_malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]);
}
