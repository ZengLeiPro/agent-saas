import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const serverRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(serverRoot, 'src', 'data', 'scenarios');
const targetRoot = join(serverRoot, 'dist', 'data', 'scenarios');
const files = ['scenario-library-v1.json', 'workflow-library-v3.json'];

await mkdir(targetRoot, { recursive: true });
await Promise.all(files.map((file) => copyFile(join(sourceRoot, file), join(targetRoot, file))));
