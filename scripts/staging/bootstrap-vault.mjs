#!/usr/bin/env node

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const STAGING_ACS_TOKEN_REF = 'STAGING_AGENT_SAAS/acs-token';

export function encryptVault({ encryptionKey, acsToken, now = new Date().toISOString() }) {
  if (typeof encryptionKey !== 'string' || encryptionKey.length < 32) {
    throw new Error('STAGING_VAULT_KEY must contain at least 32 characters');
  }
  if (typeof acsToken !== 'string' || acsToken.length < 32) {
    throw new Error('ACS_ORCH_AUTH_TOKEN must contain at least 32 characters');
  }

  const plaintext = JSON.stringify({
    version: 1,
    secrets: [
      {
        id: STAGING_ACS_TOKEN_REF,
        ownerId: 'global',
        kind: 'tenant_hand',
        value: acsToken,
        metadata: { purpose: 'staging-acs-orchestrator' },
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  const iv = randomBytes(12);
  const key = createHash('sha256').update(encryptionKey).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export async function writeVault(outputPath, options) {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(encryptVault(options))}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error('usage: bootstrap-vault.mjs <output-path>');
  }
  await writeVault(outputPath, {
    encryptionKey: process.env.STAGING_VAULT_KEY,
    acsToken: process.env.ACS_ORCH_AUTH_TOKEN,
  });
}
