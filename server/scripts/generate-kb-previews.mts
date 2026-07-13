import { resolve } from 'node:path';
import { generateKbPreviews } from '../src/kb/previewGenerator.js';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const kbRootDir = resolve(readOption('--root') ?? resolve(process.cwd(), 'server/data/kb'));
const tenantId = readOption('--tenant');
if (tenantId && !/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) {
  throw new Error('Invalid tenant id');
}

const report = await generateKbPreviews({ kbRootDir, tenantId });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failed > 0) process.exitCode = 1;
