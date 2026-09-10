import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentStore } from '../../data/agents/store.js';

const [root, side, roundsText] = process.argv.slice(2);
const rounds = Number(roundsText);
if (!root || !side || !Number.isInteger(rounds) || rounds < 1) {
  throw new Error('root, side and positive rounds are required');
}

for (let index = 0; index < rounds; index += 1) {
  const store = new AgentStore(join(root, `agents-${index}.json`));
  await writeFile(join(root, `ready-${side}-${index}`), 'ready');
  const barrier = join(root, `start-${index}`);
  while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
  await store.set(`agent-${side}`, { name: `Agent ${side}` }, `process-${side}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, side, rounds })}\n`);
