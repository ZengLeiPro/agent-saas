#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvidenceJson } from './evidence-file.mjs';
import { inventoryRecovery, planRecoveryMaintenance } from './recovery-maintenance-inventory.mjs';
import { archiveRecovery, verifyRecoveryArchive } from './recovery-maintenance-archive.mjs';

export async function runMaintenance(args) {
  const [mode, root, extra] = args;
  if (mode === 'inventory' && args.length === 2) return inventoryRecovery(root);
  if (mode === 'plan' && args.length === 3)
    return planRecoveryMaintenance(await inventoryRecovery(root), await readEvidenceJson(extra));
  if (mode === 'archive' && args.length === 3) return archiveRecovery(root, extra);
  if (mode === 'verify-archive' && args.length === 3) return verifyRecoveryArchive(root, extra);
  throw new Error('Use inventory <root>, plan <root> <policy>, archive <root> <new-dir>, or verify-archive <dir> <digest>');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runMaintenance(process.argv.slice(2)), null, 2)); }
  catch {
    // Never print caller paths, capsule bytes, private tasks or exception excerpts.
    console.error('Recovery maintenance rejected; preserve original evidence and inspect privately.');
    process.exitCode = 1;
  }
}
