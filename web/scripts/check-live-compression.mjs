import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = (process.env.VITE_WEB_ORIGIN || 'https://agent.kaiyan.net').replace(/\/+$/, '');
const distDir = resolve(process.cwd(), 'web/dist');
const html = await readFile(resolve(distDir, 'index.html'), 'utf8');
const assetPaths = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+\.(?:js|css))"/g)]
  .map((match) => new URL(match[1], origin).pathname);
const uniqueAssetPaths = [...new Set(assetPaths)];

if (!uniqueAssetPaths.some((assetPath) => assetPath.endsWith('.js'))) {
  throw new Error('Live compression gate could not find the main JS entry in web/dist/index.html');
}

for (const assetPath of uniqueAssetPaths) {
  const response = await fetch(`${origin}${assetPath}?compression_gate=${Date.now()}`, {
    headers: {
      'Accept-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
    },
  });
  if (!response.ok) {
    throw new Error(`Live compression gate failed for ${assetPath}: HTTP ${response.status}`);
  }

  const contentEncoding = response.headers.get('content-encoding')?.toLowerCase();
  if (contentEncoding !== 'gzip') {
    throw new Error(
      `Live compression gate failed for ${assetPath}: expected content-encoding=gzip, got ${contentEncoding ?? 'missing'}`,
    );
  }

  const [localBody, liveBody] = await Promise.all([
    readFile(resolve(distDir, `.${assetPath}`)),
    response.arrayBuffer().then((buffer) => Buffer.from(buffer)),
  ]);
  if (!localBody.equals(liveBody)) {
    throw new Error(`Live compression gate failed for ${assetPath}: decompressed body differs from local dist`);
  }

  console.log(`live compression ok: ${assetPath} encoding=${contentEncoding} bytes=${localBody.byteLength}`);
}
