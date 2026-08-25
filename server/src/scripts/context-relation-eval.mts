import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRelationEvaluation } from '../context/relations/evaluationRunner.js';

interface CliArgs { dataset: string; output?: string }

export function parseRelationEvalArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(dataset|output)=(.+)$/.exec(argument);
    if (!match) throw new Error(`未知参数：${argument}`);
    values.set(match[1]!, match[2]!);
  }
  const dataset = values.get('dataset')?.trim();
  if (!dataset) throw new Error('缺少 --dataset=...');
  return { dataset, ...(values.has('output') ? { output: values.get('output')! } : {}) };
}

async function main(): Promise<void> {
  const args = parseRelationEvalArgs(process.argv.slice(2));
  const bytes = await readFile(resolve(args.dataset));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const report = runRelationEvaluation(JSON.parse(bytes.toString('utf8')), hash);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) await writeFile(resolve(args.output), output, 'utf8');
  else process.stdout.write(output);
  if (!report.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
