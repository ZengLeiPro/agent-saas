#!/usr/bin/env node
// tsc 的 resolveJsonModule 只会搬运被 import 的 JSON；这里显式复制 src/schemas/*.json 到
// dist/schemas/，保证 tarball 里 schema 文件齐全（非 TypeScript 消费方按子路径直接读取）。
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const from = path.join(packageRoot, 'src', 'schemas');
const to = path.join(packageRoot, 'dist', 'schemas');

await mkdir(to, { recursive: true });
const entries = (await readdir(from)).filter((name) => name.endsWith('.json'));
if (entries.length === 0) throw new Error(`没有可复制的 schema：${from}`);
for (const name of entries) await cp(path.join(from, name), path.join(to, name));
console.log(`copied ${entries.length} schema files -> dist/schemas`);
