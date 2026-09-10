import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { UserStore } from '../../data/users/store.js';

const [filePath, readyPath, barrierPath, username] = process.argv.slice(2);
if (!filePath || !readyPath || !barrierPath || !username) {
  throw new Error('filePath, readyPath, barrierPath and username are required');
}

const store = new UserStore(filePath);
await writeFile(readyPath, 'ready');
while (!existsSync(barrierPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

try {
  const user = await store.create({
    username,
    password: 'password123',
    role: 'user',
    createdBy: 'process-e2e',
    tenantId: 'kaiyan',
  });
  process.stdout.write(`${JSON.stringify({ ok: true, id: user.id, username: user.username })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
